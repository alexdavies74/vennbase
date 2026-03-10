import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { CrdtConnectCallbacks, InviteToken, Room, RoomSnapshot } from "puter-federation-sdk";
import type { ChatMessage } from "@heyputer/puter.js";

import { loadStoredWorkerUrl } from "../src/profile";
import { WoofService } from "../src/service";

class MockKv {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<boolean> {
    this.map.set(key, value);
    return true;
  }

  async del(key: string): Promise<boolean> {
    this.map.delete(key);
    return true;
  }
}

class MockRooms {
  public failGetRoom = false;
  public readonly members = ["alex", "friend"];
  public crdtCallbacks: CrdtConnectCallbacks | null = null;

  async whoAmI(): Promise<{ username: string }> {
    return { username: "alex" };
  }

  async createRoom(name: string): Promise<Room> {
    return {
      id: "room_created",
      name,
      owner: "alex",
      workerUrl: "https://workers.puter.site/alex/rooms/room_created",
      createdAt: 1,
    };
  }

  async joinRoom(workerUrl: string, _options: { inviteToken?: string; publicKeyUrl: string }): Promise<Room> {
    return {
      id: "room_joined",
      name: "Joined",
      owner: "alex",
      workerUrl,
      createdAt: 2,
    };
  }

  parseInviteInput(input: string): { workerUrl: string; inviteToken?: string } {
    const url = new URL(input);
    const roomId = url.searchParams.get("room") ?? "room_joined";
    return {
      workerUrl: `https://workers.puter.site/alex/rooms/${roomId}`,
      inviteToken: input.includes("token") ? "invite_1" : undefined,
    };
  }

  async getRoom(workerUrl: string): Promise<RoomSnapshot> {
    if (this.failGetRoom) {
      throw new Error("room lookup failed");
    }

    const joined = workerUrl.includes("room_joined");
    return {
      id: joined ? "room_joined" : "room_created",
      name: joined ? "Joined Canonical" : "Rex Canonical",
      owner: "alex",
      workerUrl,
      createdAt: joined ? 2 : 1,
      members: ["alex"],
    };
  }

  getPublicKeyUrl(): string {
    return "https://keys.example/alex.json";
  }

  async listMembers(_room: Room): Promise<string[]> {
    return this.members;
  }

  async createInviteToken(room: Room): Promise<InviteToken> {
    return {
      token: "invite_1",
      roomId: room.id,
      invitedBy: room.owner,
      createdAt: 1,
    };
  }

  createInviteLink(room: Room, inviteToken: string): string {
    return `https://woof.example/?owner=${room.owner}&room=${room.id}&token=${inviteToken}`;
  }

  connectCrdt(_room: Room, callbacks: CrdtConnectCallbacks) {
    this.crdtCallbacks = callbacks;
    return {
      disconnect() {},
      flush: async () => {
        const update = callbacks.produceLocalUpdate();
        // In tests we don't actually send over the wire — just drain the pending update
        void update;
      },
    };
  }
}

describe("WoofService", () => {
  it("creates room on first-run adopt flow", async () => {
    const rooms = new MockRooms();
    const kv = new MockKv();
    const service = new WoofService(rooms, kv);

    const profile = await service.enterChat({ dogName: "Rex" });

    expect(profile.room.id).toBe("room_created");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBe("https://workers.puter.site/alex/rooms/room_created");
  });

  it("joins room from invite input", async () => {
    const rooms = new MockRooms();
    const kv = new MockKv();
    const service = new WoofService(rooms, kv);

    const profile = await service.joinFromInvite(
      "https://woof.example/?owner=alex&room=room_joined&token=invite_1",
    );

    expect(profile.room.id).toBe("room_joined");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBe("https://workers.puter.site/alex/rooms/room_joined");
  });

  it("restores profile by worker URL via canonical room fetch", async () => {
    const rooms = new MockRooms();
    const kv = new MockKv();
    const service = new WoofService(rooms, kv);

    await kv.set("woof:myDog", "https://workers.puter.site/alex/rooms/room_created");
    const restored = await service.restoreProfile();

    expect(restored?.room.name).toBe("Rex Canonical");
  });

  it("refreshes saved profile with canonical room metadata", async () => {
    const rooms = new MockRooms();
    const kv = new MockKv();
    const service = new WoofService(rooms, kv);

    const profile = await service.joinFromInvite(
      "https://woof.example/?owner=alex&room=room_joined&token=invite_1",
    );
    const refreshed = await service.refreshProfileCanonical(profile);

    expect(refreshed.room.name).toBe("Joined Canonical");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBe("https://workers.puter.site/alex/rooms/room_joined");
  });

  it("clears profile when canonical refresh fails", async () => {
    const rooms = new MockRooms();
    const kv = new MockKv();
    const service = new WoofService(rooms, kv);

    const profile = await service.enterChat({ dogName: "Rex" });
    rooms.failGetRoom = true;

    await expect(service.refreshProfileCanonical(profile)).rejects.toThrow("room lookup failed");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBeNull();
  });

  it("clears persisted worker URL when restore fails", async () => {
    const rooms = new MockRooms();
    const kv = new MockKv();
    const service = new WoofService(rooms, kv);

    await kv.set("woof:myDog", "https://workers.puter.site/alex/rooms/room_created");
    rooms.failGetRoom = true;

    await expect(service.restoreProfile()).rejects.toThrow("room lookup failed");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBeNull();
  });

  it("sends user and dog messages in one turn", async () => {
    const rooms = new MockRooms();
    const doc = new Y.Doc();
    const service = new WoofService(rooms, new MockKv(), doc);
    let chatInput: ChatMessage[] | undefined;

    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat(input: ChatMessage[]) {
        chatInput = input;
        return {
          message: {
            content: "woof!",
          },
        };
      },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ userType: "user", content: "hello", signedBy: "alex" });
    expect(entries[1]).toMatchObject({ userType: "dog", content: "woof!", threadUser: "alex" });
    expect(chatInput?.[0]).toEqual({
      role: "system",
      content:
        "You are Rex, a friendly dog in a shared room with separate 1:1 threads. You can reply to multiple users, but you must always reply to the trigger user. Return STRICT JSON only: {\"triggerUserReply\":\"message\",\"otherReplies\":[{\"toUser\":\"username\",\"content\":\"message\"}]} Keep content short and playful.",
    });
    expect(chatInput?.[1]).toEqual({
      role: "system",
      content: "Room members: alex, friend. Trigger user: alex.",
    });
    expect(chatInput?.[2]).toEqual({
      role: "user",
      content: "[alex \u2192 Rex] hello",
    });
  });

  it("uses canonical room name for dog persona", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());
    let chatInput: ChatMessage[] | undefined;

    const profile = await service.joinFromInvite(
      "https://woof.example/?owner=alex&room=room_joined&token=invite_1",
    );
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat(input: ChatMessage[]) {
        chatInput = input;
        return {
          message: {
            content: "woof!",
          },
        };
      },
    });

    expect(chatInput?.[0]).toEqual({
      role: "system",
      content:
        "You are Joined, a friendly dog in a shared room with separate 1:1 threads. You can reply to multiple users, but you must always reply to the trigger user. Return STRICT JSON only: {\"triggerUserReply\":\"message\",\"otherReplies\":[{\"toUser\":\"username\",\"content\":\"message\"}]} Keep content short and playful.",
    });
  });

  it("formats history as chronological user and assistant messages", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);
    let secondTurnChatInput: ChatMessage[] | undefined;

    await service.sendTurn(profile, "first", {
      async chat() {
        return {
          message: {
            content: JSON.stringify({
              triggerUserReply: "first bark",
            }),
          },
        };
      },
    });

    await service.sendTurn(profile, "second", {
      async chat(input: ChatMessage[]) {
        secondTurnChatInput = input;
        return {
          message: {
            content: "second bark",
          },
        };
      },
    });

    expect(secondTurnChatInput?.slice(2)).toEqual([
      { role: "user", content: "[alex \u2192 Rex] first" },
      { role: "assistant", content: "[Rex \u2192 alex] first bark" },
      { role: "user", content: "[alex \u2192 Rex] second" },
    ]);
  });

  it("falls back to canned dog reply when AI call fails", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());

    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat() {
        throw {
          message: "messages required",
        };
      },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ userType: "user", content: "hello" });
    expect(entries[1]).toMatchObject({ userType: "dog", content: "Rex barks happily.", threadUser: "alex" });
  });

  it("can send additional dog replies to other users", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat() {
        return {
          message: {
            content: JSON.stringify({
              triggerUserReply: "[Rex \u2192 alex] woof for alex",
              otherReplies: [
                { toUser: "friend", content: "[Rex \u2192 friend] woof for friend" },
              ],
            }),
          },
        };
      },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "woof for alex", threadUser: "alex" });
    expect(entries[2]).toMatchObject({ userType: "dog", content: "woof for friend", threadUser: "friend" });
  });

  it("strips address prefix from plain-text AI replies", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat() {
        return {
          message: {
            content: "[Rex \u2192 alex] plain woof",
          },
        };
      },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "plain woof", threadUser: "alex" });
  });

  it("forces a reply to actor when AI omits it", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat() {
        return {
          message: {
            content: JSON.stringify({
              otherReplies: [{ toUser: "friend", content: "hello friend" }],
            }),
          },
        };
      },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "Rex barks in reply.", threadUser: "alex" });
    expect(entries[2]).toMatchObject({ userType: "dog", content: "hello friend", threadUser: "friend" });
  });

  it("relinquish clears profile and disconnects CRDT", async () => {
    const rooms = new MockRooms();
    const kv = new MockKv();
    const service = new WoofService(rooms, kv);

    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.relinquish();

    await expect(loadStoredWorkerUrl(kv)).resolves.toBeNull();
  });

  it("applies remote CRDT updates via applyRemoteUpdate callback", async () => {
    const rooms = new MockRooms();
    const doc = new Y.Doc();
    const service = new WoofService(rooms, new MockKv(), doc);

    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    // Simulate a remote doc sending an update with one entry
    const remoteDoc = new Y.Doc();
    const remoteArray = remoteDoc.getArray<{ id: string; content: string; userType: string; threadUser: string | null; createdAt: number; signedBy: string }>("messages");
    remoteArray.push([{
      id: "remote_1",
      content: "hello from remote",
      userType: "user",
      threadUser: null,
      createdAt: 100,
      signedBy: "friend",
    }]);

    // Encode the remote update and apply it via the callback
    const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);
    const encodedBody = {
      type: "yjs-update",
      data: btoa(Array.from(remoteUpdate, (b) => String.fromCharCode(b)).join("")),
    };

    rooms.crdtCallbacks!.applyRemoteUpdate(encodedBody, {
      id: "msg_remote",
      roomId: "room_created",
      body: encodedBody,
      createdAt: 100,
      signedBy: "friend",
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ content: "hello from remote", signedBy: "friend" });
  });
});
