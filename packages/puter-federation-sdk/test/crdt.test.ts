import { afterEach, describe, expect, it, vi } from "vitest";

import { PutBase } from "../src/putbase";
import { RowHandle } from "../src/row-handle";
import { collection, defineSchema } from "../src/schema";

function asUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const MINIMAL_SCHEMA = defineSchema({
  rows: collection({ fields: {} }),
});

function buildRow(db: PutBase) {
  return new RowHandle(db, {
    id: "room_1",
    collection: "rows",
    owner: "owner",
    workerUrl: "https://worker.example/rooms/room_1",
  }, {});
}

describe("connectCrdt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls for remote updates and sends local updates", async () => {
    const capturedBodies: unknown[] = [];
    const requestedUrls: string[] = [];

    const remoteMessage = {
      id: "msg_remote",
      roomId: "room_1",
      body: { type: "crdt-update", data: "AAAA" },
      createdAt: 50,
      signedBy: "friend",
      sequence: 1,
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = asUrl(input);
        requestedUrls.push(url);

        if (init?.body && typeof init.body === "string") {
          capturedBodies.push(JSON.parse(init.body));
        }

        if (url.includes("/messages")) {
          const requestUrl = new URL(url);
          const sinceSequence = Number(requestUrl.searchParams.get("sinceSequence") ?? 0);
          const messages = sinceSequence < 1 ? [remoteMessage] : [];
          return new Response(JSON.stringify({ messages, latestSequence: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.includes("/message")) {
          const body = capturedBodies[capturedBodies.length - 1] as Record<string, unknown>;
          return new Response(JSON.stringify({ message: { ...body, signedBy: "owner", sequence: 2 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const receivedUpdates: unknown[] = [];
    let localUpdate: unknown = { type: "crdt-update", data: "BBBB" };

    const row = buildRow(db);
    const connection = row.connectCrdt({
      applyRemoteUpdate: (body) => { receivedUpdates.push(body); },
      produceLocalUpdate: () => {
        const update = localUpdate;
        localUpdate = null;
        return update as import("../src/types").JsonValue | null;
      },
    });

    await connection.flush();
    await connection.flush();
    connection.disconnect();

    expect(receivedUpdates).toHaveLength(1);
    expect(receivedUpdates[0]).toEqual(remoteMessage.body);

    const sentMessage = capturedBodies.find(
      (b) => (b as { body?: unknown }).body !== undefined,
    ) as { body: unknown } | undefined;
    expect(sentMessage?.body).toEqual({ type: "crdt-update", data: "BBBB" });

    expect(requestedUrls.some((u) => u.includes("/messages?sinceSequence=0"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("sinceSequence=2"))).toBe(true);
  });

  it("polls immediately and stops after disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.includes("/messages")) {
          requestedAt.push(Date.now());
          return new Response(JSON.stringify({ messages: [], latestSequence: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const row = buildRow(db);
    const connection = row.connectCrdt({
      applyRemoteUpdate() {},
      produceLocalUpdate: () => null,
    });

    await flushMicrotasks();
    expect(requestedAt).toEqual([Date.parse("2026-03-13T00:00:00.000Z")]);

    connection.disconnect();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(requestedAt).toHaveLength(1);
  });

  it("backs off to five minute polling after prolonged idleness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.includes("/messages")) {
          requestedAt.push(Date.now());
          return new Response(JSON.stringify({ messages: [], latestSequence: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const row = buildRow(db);
    const connection = row.connectCrdt({
      applyRemoteUpdate() {},
      produceLocalUpdate: () => null,
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_800_000);

    const pollsBeforeNextWindow = requestedAt.length;
    await vi.advanceTimersByTimeAsync(299_000);
    expect(requestedAt).toHaveLength(pollsBeforeNextWindow);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:35:00.000Z"));

    connection.disconnect();
  });

  it("resets back to five second polling after remote activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];

    const remoteMessage = {
      id: "msg_remote",
      roomId: "room_1",
      body: { type: "crdt-update", data: "AAAA" },
      createdAt: 75_000,
      signedBy: "friend",
      sequence: 1,
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.includes("/messages")) {
          requestedAt.push(Date.now());
          const messages = Date.now() === Date.parse("2026-03-13T00:01:15.000Z")
            ? [remoteMessage]
            : [];
          return new Response(JSON.stringify({
            messages,
            latestSequence: messages.length > 0 ? 1 : remoteMessage.sequence,
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const row = buildRow(db);
    const connection = row.connectCrdt({
      applyRemoteUpdate() {},
      produceLocalUpdate: () => null,
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:15.000Z"));

    const pollCountAfterRemote = requestedAt.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(requestedAt).toHaveLength(pollCountAfterRemote);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:20.000Z"));

    connection.disconnect();
  });

  it("flush resets polling back to five seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.includes("/messages")) {
          requestedAt.push(Date.now());
          return new Response(JSON.stringify({ messages: [], latestSequence: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const row = buildRow(db);
    const connection = row.connectCrdt({
      applyRemoteUpdate() {},
      produceLocalUpdate: () => null,
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(74_000);
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:00.000Z"));

    await connection.flush();
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:14.000Z"));

    const pollCountAfterFlush = requestedAt.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(requestedAt).toHaveLength(pollCountAfterFlush);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:19.000Z"));

    connection.disconnect();
  });
});
