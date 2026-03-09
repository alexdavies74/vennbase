import { describe, expect, it } from "vitest";

import { PuterFedRooms } from "../src/client";
import type { PuterFedRoomsOptions } from "../src/types";

describe("PuterFedRooms", () => {
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
});
