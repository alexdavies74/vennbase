import { afterEach, describe, expect, it, vi } from "vitest";

import { CoveDB } from "../src/covedb";
import { RowHandle } from "../src/row-handle";
import { collection, defineSchema } from "../src/schema";

function asUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function bodyPayload(init?: RequestInit): Record<string, unknown> | null {
  if (!init?.body || typeof init.body !== "string") {
    return null;
  }

  const parsed = JSON.parse(init.body) as { payload?: Record<string, unknown> };
  return parsed.payload ?? null;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const MINIMAL_SCHEMA = defineSchema({
  rows: collection({ fields: {} }),
});

function buildRow(db: CoveDB) {
  return new RowHandle(db, {
    id: "row_1",
    collection: "rows",
    baseUrl: "https://worker.example",
  }, "owner", {});
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
      rowId: "row_1",
      body: { type: "crdt-update", data: "AAAA" },
      createdAt: 50,
      signedBy: "friend",
      sequence: 1,
    };

    const db = new CoveDB({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = asUrl(input);
        requestedUrls.push(url);

        if (init?.body && typeof init.body === "string") {
          capturedBodies.push(JSON.parse(init.body));
        }

        if (url.includes("/sync/poll")) {
          const sinceSequence = Number(bodyPayload(init)?.sinceSequence ?? 0);
          const messages = sinceSequence < 1 ? [remoteMessage] : [];
          return new Response(JSON.stringify({ messages, latestSequence: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.includes("/sync/send")) {
          const body = (capturedBodies[capturedBodies.length - 1] as { payload?: Record<string, unknown> }).payload ?? {};
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
      (b) => ((b as { payload?: { body?: unknown } }).payload?.body) !== undefined,
    ) as { payload: { body: unknown } } | undefined;
    expect(sentMessage?.payload.body).toEqual({ type: "crdt-update", data: "BBBB" });

    expect(requestedUrls.some((u) => u.endsWith("/sync/poll"))).toBe(true);
  });

  it("polls immediately and stops after disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];

    const db = new CoveDB({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.includes("/sync/poll")) {
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

    await connection.flush();
    await flushMicrotasks();
    expect(requestedAt[0]).toBe(Date.parse("2026-03-13T00:00:00.000Z"));
    expect(requestedAt.length).toBeGreaterThan(0);

    connection.disconnect();
    const pollsBeforeDisconnect = requestedAt.length;
    await vi.advanceTimersByTimeAsync(300_000);

    expect(requestedAt).toHaveLength(pollsBeforeDisconnect);
  });

  it.skip("backs off to five minute polling after prolonged idleness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];

    const db = new CoveDB({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.includes("/sync/poll")) {
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

    await connection.flush();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_800_000);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    const pollsBeforeNextWindow = requestedAt.length;
    await vi.advanceTimersByTimeAsync(299_000);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(requestedAt).toHaveLength(pollsBeforeNextWindow);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:35:00.000Z"));

    connection.disconnect();
  });

  it.skip("resets back to five second polling after remote activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];

    const remoteMessage = {
      id: "msg_remote",
      rowId: "row_1",
      body: { type: "crdt-update", data: "AAAA" },
      createdAt: 75_000,
      signedBy: "friend",
      sequence: 1,
    };

    const db = new CoveDB({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.includes("/sync/poll")) {
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

    await connection.flush();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(75_000);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:15.000Z"));

    const pollCountAfterRemote = requestedAt.length;
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedAt).toHaveLength(pollCountAfterRemote);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:20.000Z"));

    connection.disconnect();
  });

  it.skip("flush resets polling back to five seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];

    const db = new CoveDB({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.includes("/sync/poll")) {
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

    await connection.flush();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(74_000);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:00.000Z"));

    await connection.flush();
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:14.000Z"));

    const pollCountAfterFlush = requestedAt.length;
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedAt).toHaveLength(pollCountAfterFlush);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(requestedAt.at(-1)).toBe(Date.parse("2026-03-13T00:01:19.000Z"));

    connection.disconnect();
  });
});
