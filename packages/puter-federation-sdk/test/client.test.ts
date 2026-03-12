import { describe, expect, it } from "vitest";

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

  it("uses deployed shared worker URL returned by puter.workers.create", async () => {
    const requestedUrls: string[] = [];
    const deployedWorkerBase = "https://workers.example/owner-federation";
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
      puter,
      fetchFn: fetchFn as typeof fetch,
      workerResolver: () => "https://workers.puter.site/owner-federation/rooms/room_should_not_be_used",
    });

    const room = await rooms.createRoom("Rex");

    expect(room.workerUrl.startsWith(`${deployedWorkerBase}/rooms/`)).toBe(true);
    expect(requestedUrls).toContain(`${deployedWorkerBase}/rooms`);
    expect(requestedUrls.some((url) => url.endsWith("/join"))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/room"))).toBe(true);
    expect(requestedUrls.every((url) => !url.includes("room_should_not_be_used"))).toBe(true);
  });

  it("reuses shared worker from KV across SDK instances when version matches", async () => {
    const workerKv = new InMemoryKv();
    const kv = new MapKv();
    const deployedWorkerBase = "https://workers.example/owner-federation";
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
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    const secondClient = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
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

  it("redeploys shared worker when stored version is stale", async () => {
    const workerKv = new InMemoryKv();
    const kv = new MapKv();
    const deployedWorkerBase = "https://workers.example/owner-federation";
    let deployCalls = 0;

    await kv.set("puter-fed:federation-worker-version:v1:owner", 0);
    await kv.set("puter-fed:federation-worker-url:v1:owner", "https://workers.example/old-worker");

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

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      puter,
      fetchFn: fetchFn as typeof fetch,
    });

    await rooms.createRoom("Rex");

    expect(deployCalls).toBe(1);
    await expect(kv.get("puter-fed:federation-worker-version:v1:owner")).resolves.toBe(2);
    await expect(kv.get("puter-fed:federation-worker-url:v1:owner")).resolves.toBe(deployedWorkerBase);
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
});
