import { describe, expect, it } from "vitest";

import { RoomWorker } from "../src/worker/core";
import { InMemoryKv } from "../src/worker/in-memory-kv";

async function jsonBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function authedRequest(args: {
  url: string;
  username: string;
  method: "GET" | "POST";
  body?: object;
}): Request {
  return new Request(args.url, {
    method: args.method,
    headers: {
      ...(args.body ? { "content-type": "application/json" } : {}),
      "x-puter-username": args.username,
    },
    body: args.body ? JSON.stringify(args.body) : undefined,
  });
}

class CountingKv extends InMemoryKv {
  public listCalls = 0;

  override async list(prefix: string) {
    this.listCalls += 1;
    return super.list(prefix);
  }
}

describe("RoomWorker", () => {
  it("enforces invite and members-only reads", async () => {
    const worker = new RoomWorker(
      {
        roomId: "room_1",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://workers.puter.site/owner/rooms/room_1",
      },
      { kv: new InMemoryKv() },
    );

    const ownerJoin = await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );
    expect(ownerJoin.status).toBe(200);
    expect((await jsonBody(ownerJoin)).workerUrl).toBe("https://worker.example");

    const guestJoinWithoutInvite = await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "guest",
        body: { username: "guest" },
      }),
    );

    expect(guestJoinWithoutInvite.status).toBe(401);
    expect((await jsonBody(guestJoinWithoutInvite)).code).toBe("INVITE_REQUIRED");

    const inviteResponse = await worker.handle(
      authedRequest({
        url: "https://worker.example/invite-token",
        method: "POST",
        username: "owner",
        body: {
          token: "invite_1",
          roomId: "room_1",
          invitedBy: "tampered",
          createdAt: 10,
        },
      }),
    );

    expect(inviteResponse.status).toBe(200);
    expect((await jsonBody(inviteResponse)).inviteToken).toMatchObject({
      token: "invite_1",
      roomId: "room_1",
      invitedBy: "owner",
    });

    const guestJoin = await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "guest",
        body: {
          username: "guest",
          inviteToken: "invite_1",
        },
      }),
    );

    expect(guestJoin.status).toBe(200);

    const outsiderRead = await worker.handle(
      authedRequest({
        url: "https://worker.example/messages?sinceSequence=0",
        method: "GET",
        username: "outsider",
      }),
    );

    expect(outsiderRead.status).toBe(401);
    expect((await jsonBody(outsiderRead)).code).toBe("UNAUTHORIZED");
  });

  it("rejects join username spoofing", async () => {
    const worker = new RoomWorker(
      {
        roomId: "room_auth",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://workers.puter.site/owner/rooms/room_auth",
      },
      { kv: new InMemoryKv() },
    );

    const spoofedJoin = await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "owner",
        body: { username: "guest" },
      }),
    );

    expect(spoofedJoin.status).toBe(401);
    expect((await jsonBody(spoofedJoin)).code).toBe("UNAUTHORIZED");
  });

  it("stamps message sender from authenticated requester", async () => {
    const worker = new RoomWorker(
      {
        roomId: "room_2",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://workers.puter.site/owner/rooms/room_2",
      },
      { kv: new InMemoryKv() },
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/invite-token",
        method: "POST",
        username: "owner",
        body: {
          token: "invite_2",
          roomId: "room_2",
          invitedBy: "owner",
          createdAt: 10,
        },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "guest",
        body: {
          username: "guest",
          inviteToken: "invite_2",
        },
      }),
    );

    const post = await worker.handle(
      authedRequest({
        url: "https://worker.example/message",
        method: "POST",
        username: "guest",
        body: {
          id: "msg_1",
          roomId: "room_2",
          body: { userType: "user", content: "hello" },
          createdAt: 100,
          signedBy: "owner",
        },
      }),
    );

    expect(post.status).toBe(200);
    expect((await jsonBody(post)).message).toMatchObject({
      id: "msg_1",
      roomId: "room_2",
      signedBy: "guest",
      sequence: 1,
    });
  });

  it("returns messages sorted by createdAt and id", async () => {
    const worker = new RoomWorker(
      {
        roomId: "room_3",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://workers.puter.site/owner/rooms/room_3",
      },
      { kv: new InMemoryKv() },
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/message",
        method: "POST",
        username: "owner",
        body: {
          id: "b",
          roomId: "room_3",
          body: { userType: "user", content: "b" },
          createdAt: 1000,
        },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/message",
        method: "POST",
        username: "owner",
        body: {
          id: "a",
          roomId: "room_3",
          body: { userType: "user", content: "a" },
          createdAt: 1000,
        },
      }),
    );

    const response = await worker.handle(
      authedRequest({
        url: "https://worker.example/messages?sinceSequence=0",
        method: "GET",
        username: "owner",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { messages: Array<{ id: string }> };
    expect(payload.messages.map((message) => message.id)).toEqual(["a", "b"]);
  });

  it("requires sinceSequence for message polling", async () => {
    const worker = new RoomWorker(
      {
        roomId: "room_req_seq",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://workers.puter.site/owner/rooms/room_req_seq",
      },
      { kv: new InMemoryKv() },
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    const response = await worker.handle(
      authedRequest({
        url: "https://worker.example/messages",
        method: "GET",
        username: "owner",
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json())["code"]).toBe("BAD_REQUEST");
  });

  it("uses room sequence to skip list reads when nothing changed", async () => {
    const kv = new CountingKv();
    const worker = new RoomWorker(
      {
        roomId: "room_seq",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://workers.puter.site/owner/rooms/room_seq",
      },
      { kv },
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/message",
        method: "POST",
        username: "owner",
        body: {
          id: "msg_1",
          roomId: "room_seq",
          body: { userType: "user", content: "hello" },
          createdAt: 1000,
        },
      }),
    );

    const noChangeResponse = await worker.handle(
      authedRequest({
        url: "https://worker.example/messages?sinceSequence=1",
        method: "GET",
        username: "owner",
      }),
    );
    expect(noChangeResponse.status).toBe(200);
    const noChangePayload = (await noChangeResponse.json()) as {
      messages: Array<Record<string, unknown>>;
      latestSequence: number;
    };
    expect(noChangePayload.messages).toHaveLength(0);
    expect(noChangePayload.latestSequence).toBe(1);
    expect(kv.listCalls).toBe(0);

    const changedResponse = await worker.handle(
      authedRequest({
        url: "https://worker.example/messages?sinceSequence=0",
        method: "GET",
        username: "owner",
      }),
    );
    expect(changedResponse.status).toBe(200);
    expect(kv.listCalls).toBe(1);
  });

  it("all members see all messages globally", async () => {
    const worker = new RoomWorker(
      {
        roomId: "room_4",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://workers.puter.site/owner/rooms/room_4",
      },
      { kv: new InMemoryKv() },
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/invite-token",
        method: "POST",
        username: "owner",
        body: {
          token: "invite_4",
          roomId: "room_4",
          invitedBy: "owner",
          createdAt: 10,
        },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/join",
        method: "POST",
        username: "guest",
        body: {
          username: "guest",
          inviteToken: "invite_4",
        },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/message",
        method: "POST",
        username: "guest",
        body: {
          id: "msg_guest",
          roomId: "room_4",
          body: { type: "yjs-update", data: "AAAA" },
          createdAt: 100,
        },
      }),
    );

    await worker.handle(
      authedRequest({
        url: "https://worker.example/message",
        method: "POST",
        username: "owner",
        body: {
          id: "msg_owner",
          roomId: "room_4",
          body: { type: "yjs-update", data: "BBBB" },
          createdAt: 120,
        },
      }),
    );

    for (const username of ["guest", "owner"]) {
      const response = await worker.handle(
        authedRequest({
          url: "https://worker.example/messages?sinceSequence=0",
          method: "GET",
          username,
        }),
      );
      const payload = (await response.json()) as { messages: Array<{ id: string }> };
      expect(payload.messages.map((message) => message.id)).toEqual(["msg_guest", "msg_owner"]);
    }
  });
});
