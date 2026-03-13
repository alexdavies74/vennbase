import { afterEach, describe, expect, it, vi } from "vitest";

import { PuterFedRooms } from "../src/client";
import type { PuterFedRoomsOptions } from "../src/types";
import { InMemoryKv } from "../src/worker/in-memory-kv";
import { RoomWorker } from "../src/worker/core";

function asUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function hashHostname(hostname: string): string {
  let hash = 0x811c9dc5;
  for (const char of hostname.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class MapKv {
  private readonly store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.store.has(key) ? (this.store.get(key) as T) : null;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
}

describe("PuterFedRooms", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gets room snapshot via public getRoom API", async () => {
    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);

        if (url.endsWith("/room")) {
          return new Response(
            JSON.stringify({
              id: "room_public",
              name: "Rex",
              owner: "owner",
              workerUrl: "https://worker.example/rooms/room_public",
              createdAt: 1,
              members: ["owner", "friend"],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(rooms.getRoom("https://worker.example/rooms/room_public")).resolves.toEqual({
      id: "room_public",
      name: "Rex",
      owner: "owner",
      workerUrl: "https://worker.example/rooms/room_public",
      createdAt: 1,
      members: ["owner", "friend"],
    });
  });

  it("calls provided fetchFn without binding `this` to SDK instance", async () => {
    const contexts: unknown[] = [];

    const fetchFn = function (
      this: unknown,
      input: RequestInfo | URL,
    ): Promise<Response> {
      contexts.push(this);
      const url = asUrl(input);

      if (url.endsWith("/join")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.endsWith("/room")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "room_1",
              name: "Rex",
              owner: "owner",
              workerUrl: "https://workers.puter.site/owner-federation/rooms/room_1",
              createdAt: 1,
              members: ["owner"],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof fetch;

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      fetchFn,
    });

    const room = await rooms.joinRoom("https://workers.puter.site/owner-federation/rooms/room_1");

    expect(room.id).toBe("room_1");
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((value) => value === undefined)).toBe(true);
  });

  it("provisions a host-scoped federation worker during init", async () => {
    const kv = new MapKv();
    const appHost = "woof.example";
    const hostHash = hashHostname(appHost);
    const expectedWorkerName = `owner-${hostHash}-federation`;
    const deployedWorkerBase = `https://workers.example/${expectedWorkerName}`;
    let createdName: string | null = null;

    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {
        create: async (name: string) => {
          createdName = name;
          return { success: true, url: deployedWorkerBase };
        },
      },
      kv,
    };

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: `https://${appHost}`,
      puter,
      fetchFn: (() => Promise.reject(new Error("fetch should not be used in init"))) as typeof fetch,
    });

    await rooms.init();

    expect(createdName).toBe(expectedWorkerName);
    await expect(kv.get(`puter-fed:federation-worker-version:v2:owner:${hostHash}`)).resolves.toBe(12);
    await expect(kv.get(`puter-fed:federation-worker-url:v2:owner:${hostHash}`)).resolves.toBe(deployedWorkerBase);
  });

  it("uses deployed shared worker URL returned by puter.workers.create", async () => {
    const requestedUrls: string[] = [];
    const deployedWorkerBase = "https://workers.example/owner-1234abcd-federation";
    let roomId: string | null = null;

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = asUrl(input);
      requestedUrls.push(url);

      if (url === `${deployedWorkerBase}/rooms` && init?.body && typeof init.body === "string") {
        roomId = (JSON.parse(init.body) as { roomId: string }).roomId;
        return new Response(
          JSON.stringify({
            id: roomId,
            name: "Rex",
            owner: "owner",
            workerUrl: `${deployedWorkerBase}/rooms/${roomId}`,
            createdAt: 1,
            members: [],
            parentRooms: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (roomId && url === `${deployedWorkerBase}/rooms/${roomId}/join`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (roomId && url === `${deployedWorkerBase}/rooms/${roomId}/room`) {
        return new Response(
          JSON.stringify({
            id: roomId,
            name: "Rex",
            owner: "owner",
            workerUrl: `${deployedWorkerBase}/rooms/${roomId}`,
            createdAt: 1,
            members: ["owner"],
            parentRooms: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {
        create: async () => ({ success: true, url: deployedWorkerBase }),
      },
      kv: new MapKv(),
    };

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const room = await rooms.createRoom("Rex");

    expect(room.workerUrl.startsWith(`${deployedWorkerBase}/rooms/`)).toBe(true);
    expect(requestedUrls).toContain(`${deployedWorkerBase}/rooms`);
    expect(requestedUrls.some((url) => url.endsWith("/join"))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/room"))).toBe(true);
  });

  it("reuses shared worker from KV across SDK instances for same app host", async () => {
    const workerKv = new InMemoryKv();
    const kv = new MapKv();
    const deployedWorkerBase = "https://workers.example/owner-1234abcd-federation";
    let deployCalls = 0;

    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: deployedWorkerBase,
      },
      { kv: workerKv },
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {
        create: async () => {
          deployCalls += 1;
          return { success: true, url: deployedWorkerBase };
        },
      },
      kv,
    };

    const firstClient = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const secondClient = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const firstRoom = await firstClient.createRoom("Rex");
    const secondRoom = await secondClient.createRoom("Spot");

    expect(deployCalls).toBe(1);
    expect(firstRoom.workerUrl).not.toBe(secondRoom.workerUrl);
    expect(firstRoom.workerUrl.startsWith(`${deployedWorkerBase}/rooms/`)).toBe(true);
    expect(secondRoom.workerUrl.startsWith(`${deployedWorkerBase}/rooms/`)).toBe(true);
  });

  it("reuses existing scoped worker via workers.get before creating", async () => {
    const workerKv = new InMemoryKv();
    const kv = new MapKv();
    const existingWorkerBase = "https://workers.example/owner-deadbeef-federation";
    let deployCalls = 0;
    let getCalls = 0;

    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: existingWorkerBase,
      },
      { kv: workerKv },
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {
        get: async () => {
          getCalls += 1;
          return { url: existingWorkerBase };
        },
        create: async () => {
          deployCalls += 1;
          return { url: "https://workers.example/unexpected" };
        },
      },
      kv,
    };

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const room = await rooms.createRoom("Rex");

    expect(getCalls).toBeGreaterThan(0);
    expect(deployCalls).toBe(0);
    expect(room.workerUrl.startsWith(`${existingWorkerBase}/rooms/`)).toBe(true);
  });

  it("fails hard when scoped worker name collides", async () => {
    const kv = new MapKv();
    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {
        create: async () => {
          throw {
            success: false,
            error: {
              code: "already_in_use",
              message: "already in use",
              status: 409,
            },
          };
        },
      },
      kv,
    };

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: (() => Promise.reject(new Error("fetch should not be used"))) as typeof fetch,
    });

    await expect(rooms.createRoom("Rex")).rejects.toThrow("Federation worker name collision");
  });

  it("uses puter.workers.exec when available", async () => {
    const execCalls: Array<{ url: string; init?: RequestInit }> = [];

    const puter = {
      workers: {
        exec: async (url: string, init?: RequestInit): Promise<Response> => {
          execCalls.push({ url, init });

          if (url.endsWith("/room")) {
            return new Response(
              JSON.stringify({
                id: "room_exec",
                name: "Rex",
                owner: "owner",
                workerUrl: "https://worker.example/rooms/room_exec",
                createdAt: 1,
                members: ["owner"],
                parentRooms: [],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        },
      },
    } as PuterFedRoomsOptions["puter"];

    const fetchFn = (): Promise<Response> => {
      throw new Error("fetch should not be called when workers.exec is available");
    };

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const room = await rooms.getRoom("https://worker.example/rooms/room_exec");
    expect(room.id).toBe("room_exec");
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].url).toBe("https://worker.example/rooms/room_exec/room");
    expect(new Headers(execCalls[0].init?.headers).get("x-puter-username")).toBeNull();
  });

  it("sends unsigned writes after client re-init", async () => {
    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await worker.handle(
      new Request("https://worker.example/rooms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-puter-username": "owner",
        },
        body: JSON.stringify({
          roomId: "room_reload",
          roomName: "Rex",
        }),
      }),
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const firstClient = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: fetchFn as typeof fetch,
    });
    await firstClient.init();

    const room = await firstClient.joinRoom("https://worker.example/rooms/room_reload");
    await firstClient.sendMessage(room, { userType: "user", content: "first" });

    const secondClient = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: fetchFn as typeof fetch,
    });
    await secondClient.init();

    await expect(
      secondClient.sendMessage(room, { userType: "user", content: "second" }),
    ).resolves.toMatchObject({
      roomId: room.id,
      signedBy: "owner",
    });
  });

  it("connectCrdt polls for remote updates and sends local updates", async () => {
    const capturedBodies: unknown[] = [];
    const requestedUrls: string[] = [];

    const room = {
      id: "room_1",
      name: "Rex",
      owner: "owner",
      workerUrl: "https://worker.example/rooms/room_1",
      createdAt: 1,
    };

    const remoteMessage = {
      id: "msg_remote",
      roomId: "room_1",
      body: { type: "crdt-update", data: "AAAA" },
      createdAt: 50,
      signedBy: "friend",
      sequence: 1,
    };

    const rooms = new PuterFedRooms({
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

    const connection = rooms.connectCrdt(room, {
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

  it("connectCrdt polls immediately and stops after disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];
    const room = {
      id: "room_1",
      name: "Rex",
      owner: "owner",
      workerUrl: "https://worker.example/rooms/room_1",
      createdAt: 1,
    };

    const rooms = new PuterFedRooms({
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

    const connection = rooms.connectCrdt(room, {
      applyRemoteUpdate() {},
      produceLocalUpdate: () => null,
    });

    await flushMicrotasks();
    expect(requestedAt).toEqual([Date.parse("2026-03-13T00:00:00.000Z")]);

    connection.disconnect();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(requestedAt).toHaveLength(1);
  });

  it("connectCrdt backs off to five minute polling after prolonged idleness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];
    const room = {
      id: "room_1",
      name: "Rex",
      owner: "owner",
      workerUrl: "https://worker.example/rooms/room_1",
      createdAt: 1,
    };

    const rooms = new PuterFedRooms({
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

    const connection = rooms.connectCrdt(room, {
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

  it("connectCrdt resets back to five second polling after remote activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];
    const room = {
      id: "room_1",
      name: "Rex",
      owner: "owner",
      workerUrl: "https://worker.example/rooms/room_1",
      createdAt: 1,
    };

    const remoteMessage = {
      id: "msg_remote",
      roomId: "room_1",
      body: { type: "crdt-update", data: "AAAA" },
      createdAt: 75_000,
      signedBy: "friend",
      sequence: 1,
    };

    const rooms = new PuterFedRooms({
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

    const connection = rooms.connectCrdt(room, {
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

  it("connectCrdt flush resets polling back to five seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const requestedAt: number[] = [];
    const room = {
      id: "room_1",
      name: "Rex",
      owner: "owner",
      workerUrl: "https://worker.example/rooms/room_1",
      createdAt: 1,
    };

    const rooms = new PuterFedRooms({
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

    const connection = rooms.connectCrdt(room, {
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
