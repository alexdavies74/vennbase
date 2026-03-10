import { describe, expect, it } from "vitest";

import { PuterFedRooms } from "../src/client";
import type { PuterFedRoomsOptions } from "../src/types";
import { InMemoryKv } from "../src/worker/in-memory-kv";
import { RoomWorker } from "../src/worker/core";

describe("PuterFedRooms", () => {
  it("gets room snapshot via public getRoom API", async () => {
    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url.endsWith("/room")) {
          return new Response(
            JSON.stringify({
              id: "room_public",
              name: "Rex",
              owner: "owner",
              workerUrl: "https://worker.example",
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

    await expect(rooms.getRoom("https://worker.example")).resolves.toEqual({
      id: "room_public",
      name: "Rex",
      owner: "owner",
      workerUrl: "https://worker.example",
      createdAt: 1,
      members: ["owner", "friend"],
    });
  });

  it("calls provided fetchFn without binding `this` to SDK instance", async () => {
    const contexts: unknown[] = [];

    const fetchFn = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      contexts.push(this);

      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

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
              workerUrl: "https://workers.puter.site/owner/room-room_1",
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

    const room = await rooms.joinRoom("https://workers.puter.site/owner/room-room_1", {
      publicKeyUrl: "data:application/json;base64,e30=",
    });

    expect(room.id).toBe("room_1");
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((value) => value === undefined)).toBe(true);
  });

  it("uses deployed worker URL returned by puter.workers.create", async () => {
    const requestedUrls: string[] = [];
    const deployedWorkerUrl = "https://workers.example/owner/real-worker";

    const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      requestedUrls.push(url);

      if (url === `${deployedWorkerUrl}/join`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === `${deployedWorkerUrl}/room`) {
        return new Response(
          JSON.stringify({
            id: "room_test",
            name: "Rex",
            owner: "owner",
            workerUrl: deployedWorkerUrl,
            createdAt: 1,
            members: ["owner"],
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
    };

    const puter: NonNullable<PuterFedRoomsOptions["puter"]> = {
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {
        create: async () => ({ success: true, url: deployedWorkerUrl }),
      },
    };

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      puter,
      fetchFn: fetchFn as typeof fetch,
      workerResolver: () => "https://workers.puter.site/owner/rooms/room_should_not_be_used",
    });

    const room = await rooms.createRoom("Rex");

    expect(room.workerUrl).toBe(deployedWorkerUrl);
    expect(requestedUrls).toContain(`${deployedWorkerUrl}/join`);
    expect(requestedUrls).toContain(`${deployedWorkerUrl}/room`);
    expect(requestedUrls.every((url) => !url.includes("room_should_not_be_used"))).toBe(true);
  });

  it("reuses signer keys from puter.kv so writes still work after client re-init", async () => {
    const worker = new RoomWorker(
      {
        roomId: "room_reload",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    const signerKeyStore = new Map<string, unknown>();
    const puter = {
      kv: {
        get: async <T>(key: string): Promise<T | undefined> => signerKeyStore.get(key) as T | undefined,
        set: async <T>(key: string, value: T): Promise<boolean> => {
          signerKeyStore.set(key, value);
          return true;
        },
      },
    } as PuterFedRoomsOptions["puter"];

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        init,
      );
      return worker.handle(request);
    };

    const firstClient = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      puter,
      fetchFn: fetchFn as typeof fetch,
    });
    await firstClient.init();

    const room = await firstClient.joinRoom("https://worker.example", {
      publicKeyUrl: firstClient.getPublicKeyUrl(),
    });
    await firstClient.sendMessage(room, { userType: "user", content: "first" });

    const secondClient = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      puter,
      fetchFn: fetchFn as typeof fetch,
    });
    await secondClient.init();

    await expect(
      secondClient.sendMessage(room, { userType: "user", content: "second" }),
    ).resolves.toMatchObject({
      roomId: room.id,
      signedBy: "owner",
    });
    expect(signerKeyStore.size).toBeGreaterThan(0);
  });

  it("connectCrdt polls for remote updates and sends local updates", async () => {
    const capturedBodies: unknown[] = [];
    const requestedUrls: string[] = [];

    const room = {
      id: "room_1",
      name: "Rex",
      owner: "owner",
      workerUrl: "https://worker.example",
      createdAt: 1,
    };

    const remoteMessage = {
      id: "msg_remote",
      roomId: "room_1",
      body: { type: "crdt-update", data: "AAAA" },
      createdAt: 50,
      signedBy: "friend",
    };

    let pollCount = 0;

    const rooms = new PuterFedRooms({
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        requestedUrls.push(url);

        if (init?.body && typeof init.body === "string") {
          capturedBodies.push(JSON.parse(init.body));
        }

        if (url.includes("/messages")) {
          pollCount++;
          const messages = pollCount === 1 ? [remoteMessage] : [];
          return new Response(JSON.stringify({ messages }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.includes("/message")) {
          const body = capturedBodies[capturedBodies.length - 1] as { payload: unknown };
          return new Response(JSON.stringify({ message: body.payload }), {
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

    // First tick runs immediately — wait for it to complete
    await connection.flush();
    connection.disconnect();

    // Remote message body was delivered to applyRemoteUpdate
    expect(receivedUpdates).toHaveLength(1);
    expect(receivedUpdates[0]).toEqual(remoteMessage.body);

    // Local update was sent as a message
    const sentEnvelope = capturedBodies.find(
      (b) => (b as { payload?: { body?: unknown } }).payload?.body !== undefined,
    ) as { payload: { body: unknown } } | undefined;
    expect(sentEnvelope?.payload.body).toEqual({ type: "crdt-update", data: "BBBB" });

    // Poll URL uses correct after param
    expect(requestedUrls.some((u) => u.includes("/messages?after=0"))).toBe(true);
  });
});
