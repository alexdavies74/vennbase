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
      new Request("https://worker.example/messages?after=0", {
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

    const crossThreadUserEnvelope = await signEnvelope(
      "message",
      {
        id: "msg_cross_thread",
        roomId: "room_2",
        body: { userType: "user", content: "not allowed" },
        createdAt: 101,
        signedBy: "guest",
        threadUser: "owner",
      },
      {
        username: "guest",
        publicKeyUrl: guest.publicKeyUrl,
      },
      guest.keyPair.privateKey,
      101,
    );

    const crossThreadUserResponse = await worker.handle(
      new Request("https://worker.example/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify(crossThreadUserEnvelope),
      }),
    );

    expect(crossThreadUserResponse.status).toBe(401);
    expect((await jsonBody(crossThreadUserResponse)).code).toBe("UNAUTHORIZED");
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
      new Request("https://worker.example/messages?after=0", {
        method: "GET",
        headers: { "x-puter-username": "owner" },
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { messages: Array<{ id: string }> };
    expect(payload.messages.map((message) => message.id)).toEqual(["a", "b"]);
  });

  it("scopes /messages to requester thread and supports global history scope", async () => {
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
    const friend = await createIdentity("friend");

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

    await worker.handle(
      new Request("https://worker.example/join", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "friend" },
        body: JSON.stringify({
          username: "friend",
          publicKeyUrl: friend.publicKeyUrl,
          inviteToken: "invite_4",
        }),
      }),
    );

    const guestMsg = await signEnvelope(
      "message",
      {
        id: "msg_guest",
        roomId: "room_4",
        body: { userType: "user", content: "hi from guest" },
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

    const dogToFriendMsg = await signEnvelope(
      "message",
      {
        id: "msg_dog_to_friend",
        roomId: "room_4",
        body: { userType: "dog", content: "woof friend" },
        createdAt: 110,
        signedBy: "guest",
        threadUser: "friend",
      },
      {
        username: "guest",
        publicKeyUrl: guest.publicKeyUrl,
      },
      guest.keyPair.privateKey,
      110,
    );

    await worker.handle(
      new Request("https://worker.example/message", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "guest" },
        body: JSON.stringify(dogToFriendMsg),
      }),
    );

    const ownerMsg = await signEnvelope(
      "message",
      {
        id: "msg_owner",
        roomId: "room_4",
        body: { userType: "user", content: "owner note" },
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

    const guestThreadResponse = await worker.handle(
      new Request("https://worker.example/messages?after=0", {
        method: "GET",
        headers: { "x-puter-username": "guest" },
      }),
    );
    const guestThreadPayload = (await guestThreadResponse.json()) as { messages: Array<{ id: string }> };
    expect(guestThreadPayload.messages.map((message) => message.id)).toEqual(["msg_guest"]);

    const friendThreadResponse = await worker.handle(
      new Request("https://worker.example/messages?after=0", {
        method: "GET",
        headers: { "x-puter-username": "friend" },
      }),
    );
    const friendThreadPayload = (await friendThreadResponse.json()) as { messages: Array<{ id: string }> };
    expect(friendThreadPayload.messages.map((message) => message.id)).toEqual(["msg_dog_to_friend"]);

    const guestGlobalResponse = await worker.handle(
      new Request("https://worker.example/messages?after=0&scope=global", {
        method: "GET",
        headers: { "x-puter-username": "guest" },
      }),
    );
    const guestGlobalPayload = (await guestGlobalResponse.json()) as { messages: Array<{ id: string }> };
    expect(guestGlobalPayload.messages.map((message) => message.id)).toEqual([
      "msg_guest",
      "msg_dog_to_friend",
      "msg_owner",
    ]);
  });
});
