import { describe, expect, it } from "vitest";

import { RoomWorker } from "../src/worker/core";
import { InMemoryKv } from "../src/worker/in-memory-kv";

async function jsonBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function roomEndpoint(roomId: string, endpoint: string): string {
  return `https://worker.example/rooms/${encodeURIComponent(roomId)}/${endpoint}`;
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

async function createRoom(worker: RoomWorker, roomId: string, roomName = "Rex"): Promise<Response> {
  return worker.handle(
    authedRequest({
      url: "https://worker.example/rooms",
      method: "POST",
      username: "owner",
      body: {
        roomId,
        roomName,
      },
    }),
  );
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
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    const created = await createRoom(worker, "room_1");
    expect(created.status).toBe(200);

    const ownerJoin = await worker.handle(
      authedRequest({
        url: roomEndpoint("room_1", "join"),
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );
    expect(ownerJoin.status).toBe(200);
    expect((await jsonBody(ownerJoin)).workerUrl).toBe("https://worker.example/rooms/room_1");

    const guestJoinWithoutInvite = await worker.handle(
      authedRequest({
        url: roomEndpoint("room_1", "join"),
        method: "POST",
        username: "guest",
        body: { username: "guest" },
      }),
    );

    expect(guestJoinWithoutInvite.status).toBe(401);
    expect((await jsonBody(guestJoinWithoutInvite)).code).toBe("INVITE_REQUIRED");

    const inviteResponse = await worker.handle(
      authedRequest({
        url: roomEndpoint("room_1", "invite-token"),
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
        url: roomEndpoint("room_1", "join"),
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
        url: `${roomEndpoint("room_1", "messages")}?sinceSequence=0`,
        method: "GET",
        username: "outsider",
      }),
    );

    expect(outsiderRead.status).toBe(401);
    expect((await jsonBody(outsiderRead)).code).toBe("UNAUTHORIZED");
  });

  it("requires owner auth for room creation", async () => {
    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    const response = await worker.handle(
      authedRequest({
        url: "https://worker.example/rooms",
        method: "POST",
        username: "guest",
        body: {
          roomId: "room_auth",
          roomName: "Rex",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect((await jsonBody(response)).code).toBe("UNAUTHORIZED");
  });

  it("rejects join username spoofing", async () => {
    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRoom(worker, "room_auth");

    const spoofedJoin = await worker.handle(
      authedRequest({
        url: roomEndpoint("room_auth", "join"),
        method: "POST",
        username: "owner",
        body: { username: "guest" },
      }),
    );

    expect(spoofedJoin.status).toBe(401);
    expect((await jsonBody(spoofedJoin)).code).toBe("UNAUTHORIZED");
  });

  it("stores canonical parent refs in room snapshots and unlinks by full ref", async () => {
    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRoom(worker, "project_1", "Project");
    await createRoom(worker, "task_1", "Task");

    await worker.handle(
      authedRequest({
        url: roomEndpoint("project_1", "join"),
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );
    await worker.handle(
      authedRequest({
        url: roomEndpoint("task_1", "join"),
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: roomEndpoint("project_1", "fields"),
        method: "POST",
        username: "owner",
        body: {
          fields: { name: "Project" },
          collection: "projects",
        },
      }),
    );
    await worker.handle(
      authedRequest({
        url: roomEndpoint("task_1", "fields"),
        method: "POST",
        username: "owner",
        body: {
          fields: { title: "Task" },
          collection: "tasks",
        },
      }),
    );

    const parentRef = {
      id: "project_1",
      collection: "projects",
      owner: "owner",
      workerUrl: "https://worker.example/rooms/project_1",
    };

    const link = await worker.handle(
      authedRequest({
        url: roomEndpoint("task_1", "link-parent"),
        method: "POST",
        username: "owner",
        body: { parentRef },
      }),
    );

    expect(link.status).toBe(200);
    expect((await jsonBody(link)).parentRefs).toEqual([parentRef]);

    const snapshot = await worker.handle(
      authedRequest({
        url: roomEndpoint("task_1", "room"),
        method: "GET",
        username: "owner",
      }),
    );

    expect(snapshot.status).toBe(200);
    expect((await jsonBody(snapshot))).toMatchObject({
      id: "task_1",
      collection: "tasks",
      parentRefs: [parentRef],
    });

    const unlink = await worker.handle(
      authedRequest({
        url: roomEndpoint("task_1", "unlink-parent"),
        method: "POST",
        username: "owner",
        body: { parentRef },
      }),
    );

    expect(unlink.status).toBe(200);
    expect((await jsonBody(unlink)).parentRefs).toEqual([]);
  });

  it("stamps message sender from authenticated requester", async () => {
    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRoom(worker, "room_2");

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_2", "join"),
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_2", "invite-token"),
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
        url: roomEndpoint("room_2", "join"),
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
        url: roomEndpoint("room_2", "message"),
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
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRoom(worker, "room_3");

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_3", "join"),
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_3", "message"),
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
        url: roomEndpoint("room_3", "message"),
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
        url: `${roomEndpoint("room_3", "messages")}?sinceSequence=0`,
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
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRoom(worker, "room_req_seq");

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_req_seq", "join"),
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    const response = await worker.handle(
      authedRequest({
        url: roomEndpoint("room_req_seq", "messages"),
        method: "GET",
        username: "owner",
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("BAD_REQUEST");
  });

  it("uses room sequence to skip list reads when nothing changed", async () => {
    const kv = new CountingKv();
    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv },
    );

    await createRoom(worker, "room_seq");

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_seq", "join"),
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_seq", "message"),
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
        url: `${roomEndpoint("room_seq", "messages")}?sinceSequence=1`,
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
        url: `${roomEndpoint("room_seq", "messages")}?sinceSequence=0`,
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
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRoom(worker, "room_4");

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_4", "join"),
        method: "POST",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      authedRequest({
        url: roomEndpoint("room_4", "invite-token"),
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
        url: roomEndpoint("room_4", "join"),
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
        url: roomEndpoint("room_4", "message"),
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
        url: roomEndpoint("room_4", "message"),
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
          url: `${roomEndpoint("room_4", "messages")}?sinceSequence=0`,
          method: "GET",
          username,
        }),
      );
      const payload = (await response.json()) as { messages: Array<{ id: string }> };
      expect(payload.messages.map((message) => message.id)).toEqual(["msg_guest", "msg_owner"]);
    }
  });

  it("allows puter-auth in CORS preflight", async () => {
    const worker = new RoomWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    const response = await worker.handle(
      new Request(roomEndpoint("room_cors", "join"), {
        method: "OPTIONS",
        headers: {
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,puter-auth",
        },
      }),
    );

    expect(response.status).toBe(204);
    const allowHeaders = response.headers.get("access-control-allow-headers");
    expect(allowHeaders).toContain("puter-auth");
  });
});
