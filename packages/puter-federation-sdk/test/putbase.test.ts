import { afterEach, describe, expect, it, vi } from "vitest";

import { PutBase } from "../src/putbase";
import { RowHandle } from "../src/row-handle";
import { collection, defineSchema } from "../src/schema";
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

class MapKv {
  private readonly store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.store.has(key) ? (this.store.get(key) as T) : null;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
}

const MINIMAL_SCHEMA = defineSchema({
  rows: collection({ fields: {} }),
});

describe("PutBase", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gets row by URL", async () => {
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
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
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (url.endsWith("/fields")) {
          return new Response(
            JSON.stringify({ fields: { name: "Rex" }, collection: "rows" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const row = await db.getRowByUrl("https://worker.example/rooms/room_public");
    expect(row.id).toBe("room_public");
    expect(row.owner).toBe("owner");
    expect(row.workerUrl).toBe("https://worker.example/rooms/room_public");
    expect(row.fields.name).toBe("Rex");
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
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }

      if (url.endsWith("/fields")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ fields: {}, collection: "rows" }),
            { status: 200, headers: { "content-type": "application/json" } },
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

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn,
    });

    const row = await db.joinRow("https://workers.puter.site/owner-federation/rooms/room_1");

    expect(row.id).toBe("room_1");
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

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: `https://${appHost}`,
      puter,
      fetchFn: (() => Promise.reject(new Error("fetch should not be used in init"))) as typeof fetch,
    });

    await db.init();

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

      if (roomId && url === `${deployedWorkerBase}/rooms/${roomId}/fields`) {
        return new Response(
          JSON.stringify({ fields: { name: "Rex" }, collection: "rows" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
      workers: { create: async () => ({ success: true, url: deployedWorkerBase }) },
      kv: new MapKv(),
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const row = await db.put("rows", { name: "Rex" });

    expect(row.workerUrl.startsWith(`${deployedWorkerBase}/rooms/`)).toBe(true);
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
      { owner: "owner", workerUrl: deployedWorkerBase },
      { kv: workerKv },
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
      workers: {
        create: async () => {
          deployCalls += 1;
          return { success: true, url: deployedWorkerBase };
        },
      },
      kv,
    };

    const firstDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const secondDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const firstRow = await firstDb.put("rows", { name: "Rex" });
    const secondRow = await secondDb.put("rows", { name: "Spot" });

    expect(deployCalls).toBe(1);
    expect(firstRow.workerUrl).not.toBe(secondRow.workerUrl);
    expect(firstRow.workerUrl.startsWith(`${deployedWorkerBase}/rooms/`)).toBe(true);
    expect(secondRow.workerUrl.startsWith(`${deployedWorkerBase}/rooms/`)).toBe(true);
  });

  it("reuses existing scoped worker via workers.get before creating", async () => {
    const workerKv = new InMemoryKv();
    const kv = new MapKv();
    const existingWorkerBase = "https://workers.example/owner-deadbeef-federation";
    let deployCalls = 0;
    let getCalls = 0;

    const worker = new RoomWorker(
      { owner: "owner", workerUrl: existingWorkerBase },
      { kv: workerKv },
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
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

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const row = await db.put("rows", { name: "Rex" });

    expect(getCalls).toBeGreaterThan(0);
    expect(deployCalls).toBe(0);
    expect(row.workerUrl.startsWith(`${existingWorkerBase}/rooms/`)).toBe(true);
  });

  it("fails hard when scoped worker name collides", async () => {
    const kv = new MapKv();
    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
      workers: {
        create: async () => {
          throw {
            success: false,
            error: { code: "already_in_use", message: "already in use", status: 409 },
          };
        },
      },
      kv,
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://woof.example",
      puter,
      fetchFn: (() => Promise.reject(new Error("fetch should not be used"))) as typeof fetch,
    });

    await expect(db.put("rows", { name: "Rex" })).rejects.toThrow("Federation worker name collision");
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

          if (url.endsWith("/fields")) {
            return new Response(
              JSON.stringify({ fields: { name: "Rex" }, collection: "rows" }),
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

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const row = await db.getRowByUrl("https://worker.example/rooms/room_exec");
    expect(row.id).toBe("room_exec");
    expect(execCalls.some((c) => c.url.endsWith("/room"))).toBe(true);
    expect(execCalls.some((c) => c.url.endsWith("/fields"))).toBe(true);
    expect(new Headers(execCalls[0].init?.headers).get("x-puter-username")).toBeNull();
  });

  it("can flush CRDT updates after client re-init", async () => {
    const worker = new RoomWorker(
      { owner: "owner", workerUrl: "https://worker.example" },
      { kv: new InMemoryKv() },
    );

    await worker.handle(
      new Request("https://worker.example/rooms", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify({ roomId: "room_reload", roomName: "Rex" }),
      }),
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const rowRef = {
      id: "room_reload",
      collection: "rows",
      owner: "owner",
      workerUrl: "https://worker.example/rooms/room_reload",
    };

    const firstDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: fetchFn as typeof fetch,
    });
    await firstDb.init();

    const row1 = new RowHandle(firstDb, rowRef, {});
    const conn1 = row1.connectCrdt({
      applyRemoteUpdate() {},
      produceLocalUpdate: () => ({ type: "yjs-update", data: "AAAA" }),
    });
    await conn1.flush();
    conn1.disconnect();

    const secondDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: fetchFn as typeof fetch,
    });
    await secondDb.init();

    const row2 = new RowHandle(secondDb, rowRef, {});
    const conn2 = row2.connectCrdt({
      applyRemoteUpdate() {},
      produceLocalUpdate: () => ({ type: "yjs-update", data: "BBBB" }),
    });
    await expect(conn2.flush()).resolves.toBeUndefined();
    conn2.disconnect();
  });
});
