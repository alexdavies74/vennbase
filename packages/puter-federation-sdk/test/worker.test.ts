import { describe, expect, it } from "vitest";

import {
  buildPublicKeyProofDocument,
  encodeProofDocumentAsDataUrl,
  exportPublicJwk,
  generateP256KeyPair,
  signEnvelope,
} from "../src/crypto";
import { RoomWorker } from "../src/worker/core";
import { InMemoryKv } from "../src/worker/in-memory-kv";

async function createIdentity(username: string) {
  const keyPair = await generateP256KeyPair();
  const publicKeyJwk = await exportPublicJwk(keyPair.publicKey);
  const publicKeyUrl = encodeProofDocumentAsDataUrl(
    buildPublicKeyProofDocument(username, publicKeyJwk),
  );

  return {
    username,
    keyPair,
    publicKeyUrl,
  };
}

async function jsonBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
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

    const owner = await createIdentity("owner");
    const guest = await createIdentity("guest");

    const ownerJoin = await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify({ username: "owner", publicKeyUrl: owner.publicKeyUrl }),
      }),
    );
    expect(ownerJoin.status).toBe(200);
    expect((await jsonBody(ownerJoin)).workerUrl).toBe("https://worker.example");

    const guestJoinWithoutInvite = await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify({ username: "guest", publicKeyUrl: guest.publicKeyUrl }),
      }),
    );

    expect(guestJoinWithoutInvite.status).toBe(401);
    expect((await jsonBody(guestJoinWithoutInvite)).code).toBe("INVITE_REQUIRED");

    const inviteEnvelope = await signEnvelope(
      "invite-token",
      {
        token: "invite_1",
        roomId: "room_1",
        invitedBy: "owner",
        createdAt: 10,
      },
      {
        username: "owner",
        publicKeyUrl: owner.publicKeyUrl,
      },
      owner.keyPair.privateKey,
      10,
    );

    const inviteResponse = await worker.handle(
      new Request("https://worker.example/invite-token", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify(inviteEnvelope),
      }),
    );

    expect(inviteResponse.status).toBe(200);

    const guestJoin = await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify({
          username: "guest",
          publicKeyUrl: guest.publicKeyUrl,
          inviteToken: "invite_1",
        }),
      }),
    );

    expect(guestJoin.status).toBe(200);

    const outsiderRead = await worker.handle(
      new Request("https://worker.example/messages?sinceSequence=0", {
        method: "GET",
        headers: { "x-puter-username": "outsider" },
      }),
    );

    expect(outsiderRead.status).toBe(401);
    expect((await jsonBody(outsiderRead)).code).toBe("UNAUTHORIZED");
  });

  it("rejects key changes and invalid signatures", async () => {
    const worker = new RoomWorker(
      {
        roomId: "room_2",
        roomName: "Rex",
        owner: "owner",
        workerUrl: "https://workers.puter.site/owner/rooms/room_2",
      },
      { kv: new InMemoryKv() },
    );

    const owner = await createIdentity("owner");
    const guest = await createIdentity("guest");
    const guestSecondKey = await createIdentity("guest");

    await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify({ username: "owner", publicKeyUrl: owner.publicKeyUrl }),
      }),
    );

    const inviteEnvelope = await signEnvelope(
      "invite-token",
      {
        token: "invite_2",
        roomId: "room_2",
        invitedBy: "owner",
        createdAt: 10,
      },
      {
        username: "owner",
        publicKeyUrl: owner.publicKeyUrl,
      },
      owner.keyPair.privateKey,
      10,
    );

    await worker.handle(
      new Request("https://worker.example/invite-token", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify(inviteEnvelope),
      }),
    );

    await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify({
          username: "guest",
          publicKeyUrl: guest.publicKeyUrl,
          inviteToken: "invite_2",
        }),
      }),
    );

    const keyMismatch = await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify({
          username: "guest",
          publicKeyUrl: guestSecondKey.publicKeyUrl,
        }),
      }),
    );

    expect(keyMismatch.status).toBe(409);
    expect((await jsonBody(keyMismatch)).code).toBe("KEY_MISMATCH");

    const messageEnvelope = await signEnvelope(
      "message",
      {
        id: "msg_1",
        roomId: "room_2",
        body: { userType: "user", content: "hello" },
        createdAt: 100,
        signedBy: "guest",
      },
      {
        username: "guest",
        publicKeyUrl: guest.publicKeyUrl,
      },
      guest.keyPair.privateKey,
      100,
    );

    messageEnvelope.payload.body = { userType: "user", content: "tampered" };

    const invalidSignature = await worker.handle(
      new Request("https://worker.example/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify(messageEnvelope),
      }),
    );

    expect(invalidSignature.status).toBe(401);
    expect((await jsonBody(invalidSignature)).code).toBe("INVALID_SIGNATURE");
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

    const owner = await createIdentity("owner");

    await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify({ username: "owner", publicKeyUrl: owner.publicKeyUrl }),
      }),
    );

    const msgB = await signEnvelope(
      "message",
      {
        id: "b",
        roomId: "room_3",
        body: { userType: "user", content: "b" },
        createdAt: 1000,
        signedBy: "owner",
      },
      {
        username: "owner",
        publicKeyUrl: owner.publicKeyUrl,
      },
      owner.keyPair.privateKey,
      1000,
    );

    const msgA = await signEnvelope(
      "message",
      {
        id: "a",
        roomId: "room_3",
        body: { userType: "user", content: "a" },
        createdAt: 1000,
        signedBy: "owner",
      },
      {
        username: "owner",
        publicKeyUrl: owner.publicKeyUrl,
      },
      owner.keyPair.privateKey,
      1000,
    );

    await worker.handle(
      new Request("https://worker.example/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify(msgB),
      }),
    );

    await worker.handle(
      new Request("https://worker.example/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify(msgA),
      }),
    );

    const response = await worker.handle(
      new Request("https://worker.example/messages?sinceSequence=0", {
        method: "GET",
        headers: { "x-puter-username": "owner" },
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

    const owner = await createIdentity("owner");

    await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify({ username: "owner", publicKeyUrl: owner.publicKeyUrl }),
      }),
    );

    const response = await worker.handle(
      new Request("https://worker.example/messages", {
        method: "GET",
        headers: { "x-puter-username": "owner" },
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

    const owner = await createIdentity("owner");

    await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify({ username: "owner", publicKeyUrl: owner.publicKeyUrl }),
      }),
    );

    const msg = await signEnvelope(
      "message",
      {
        id: "msg_1",
        roomId: "room_seq",
        body: { userType: "user", content: "hello" },
        createdAt: 1000,
        signedBy: "owner",
      },
      {
        username: "owner",
        publicKeyUrl: owner.publicKeyUrl,
      },
      owner.keyPair.privateKey,
      1000,
    );

    await worker.handle(
      new Request("https://worker.example/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify(msg),
      }),
    );

    const noChangeResponse = await worker.handle(
      new Request("https://worker.example/messages?sinceSequence=1", {
        method: "GET",
        headers: { "x-puter-username": "owner" },
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
      new Request("https://worker.example/messages?sinceSequence=0", {
        method: "GET",
        headers: { "x-puter-username": "owner" },
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

    const owner = await createIdentity("owner");
    const guest = await createIdentity("guest");

    await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify({ username: "owner", publicKeyUrl: owner.publicKeyUrl }),
      }),
    );

    const inviteEnvelope = await signEnvelope(
      "invite-token",
      {
        token: "invite_4",
        roomId: "room_4",
        invitedBy: "owner",
        createdAt: 10,
      },
      {
        username: "owner",
        publicKeyUrl: owner.publicKeyUrl,
      },
      owner.keyPair.privateKey,
      10,
    );

    await worker.handle(
      new Request("https://worker.example/invite-token", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify(inviteEnvelope),
      }),
    );

    await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify({
          username: "guest",
          publicKeyUrl: guest.publicKeyUrl,
          inviteToken: "invite_4",
        }),
      }),
    );

    const guestMsg = await signEnvelope(
      "message",
      {
        id: "msg_guest",
        roomId: "room_4",
        body: { type: "yjs-update", data: "AAAA" },
        createdAt: 100,
        signedBy: "guest",
      },
      {
        username: "guest",
        publicKeyUrl: guest.publicKeyUrl,
      },
      guest.keyPair.privateKey,
      100,
    );

    await worker.handle(
      new Request("https://worker.example/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify(guestMsg),
      }),
    );

    const ownerMsg = await signEnvelope(
      "message",
      {
        id: "msg_owner",
        roomId: "room_4",
        body: { type: "yjs-update", data: "BBBB" },
        createdAt: 120,
        signedBy: "owner",
      },
      {
        username: "owner",
        publicKeyUrl: owner.publicKeyUrl,
      },
      owner.keyPair.privateKey,
      120,
    );

    await worker.handle(
      new Request("https://worker.example/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify(ownerMsg),
      }),
    );

    // Both guest and owner see all messages
    for (const username of ["guest", "owner"]) {
      const response = await worker.handle(
        new Request("https://worker.example/messages?sinceSequence=0", {
          method: "GET",
          headers: { "x-puter-username": username },
        }),
      );
      const payload = (await response.json()) as { messages: Array<{ id: string }> };
      expect(payload.messages.map((message) => message.id)).toEqual(["msg_guest", "msg_owner"]);
    }
  });
});
