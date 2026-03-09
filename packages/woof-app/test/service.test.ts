import { describe, expect, it } from "vitest";

import type { InviteToken, Message, Room, RoomSnapshot } from "puter-federation-sdk";
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

class MockTimer {
  public clearCalls: number[] = [];

  setInterval(): number {
    return 42;
  }

  clearInterval(handle: number): void {
    this.clearCalls.push(handle);
  }
}

class MockRooms {
  public sentMessages: Array<{
    room: Room;
    body: Message["body"];
    options?: { threadUser?: string };
  }> = [];
  public failGetRoom = false;
  public readonly members = ["alex", "friend"];

  private messageCounter = 0;

  private readonly globalMessages: Message[] = [];

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

  async sendMessage(room: Room, body: Message["body"], options?: { threadUser?: string }): Promise<void> {
    this.sentMessages.push({ room, body, options });

    const createdAt = ++this.messageCounter;
    this.globalMessages.push({
      id: `msg_${createdAt}`,
      roomId: room.id,
      body,
      createdAt,
      signedBy: "alex",
      threadUser: options?.threadUser ?? "alex",
    });
  }

  async pollMessages(
    _room: Room,
    sinceTimestamp: number,
    options?: { scope?: "thread" | "global" },
  ): Promise<Message[]> {
    const scope = options?.scope ?? "thread";
    if (scope === "global") {
      return this.globalMessages.filter((message) => message.createdAt > sinceTimestamp);
    }

    return this.globalMessages.filter(
      (message) => message.createdAt > sinceTimestamp && (message.threadUser ?? message.signedBy) === "alex",
    );
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
    const service = new WoofService(rooms, new MockKv());
    let chatInput: ChatMessage[] | undefined;

    const profile = await service.enterChat({ dogName: "Rex" });

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

    expect(rooms.sentMessages).toHaveLength(2);
    expect(rooms.sentMessages[0].body).toEqual({ userType: "user", content: "hello" });
    expect(rooms.sentMessages[1].body).toEqual({ userType: "dog", content: "woof!", toUser: "alex" });
    expect(rooms.sentMessages[1].options).toEqual({ threadUser: "alex" });
    expect(chatInput?.[0]).toEqual({
      role: "system",
      content:
        "You are Rex, a friendly dog in a shared room with separate 1:1 threads. You can reply to multiple users, but you must always reply to the trigger user. Return STRICT JSON only: {\"replies\":[{\"toUser\":\"username\",\"content\":\"message\"}]} Keep content short and playful.",
    });
    expect(chatInput?.[1].role).toBe("user");
    const promptPayload = JSON.parse(String(chatInput?.[1].content));
    expect(promptPayload.triggerUser).toBe("alex");
    expect(promptPayload.latestUserMessage).toBe("hello");
    expect(promptPayload.members).toEqual(["alex", "friend"]);
  });

  it("uses canonical room name for dog persona", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());
    let chatInput: ChatMessage[] | undefined;

    const profile = await service.joinFromInvite(
      "https://woof.example/?owner=alex&room=room_joined&token=invite_1",
    );

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
        "You are Joined, a friendly dog in a shared room with separate 1:1 threads. You can reply to multiple users, but you must always reply to the trigger user. Return STRICT JSON only: {\"replies\":[{\"toUser\":\"username\",\"content\":\"message\"}]} Keep content short and playful.",
    });
  });

  it("falls back to canned dog reply when AI call fails", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());

    const profile = await service.enterChat({ dogName: "Rex" });

    await service.sendTurn(profile, "hello", {
      async chat() {
        throw {
          message: "messages required",
        };
      },
    });

    expect(rooms.sentMessages).toHaveLength(2);
    expect(rooms.sentMessages[0].body).toEqual({ userType: "user", content: "hello" });
    expect(rooms.sentMessages[1].body).toEqual({
      userType: "dog",
      content: "Rex barks happily.",
      toUser: "alex",
    });
    expect(rooms.sentMessages[1].options).toEqual({ threadUser: "alex" });
  });

  it("can send additional dog replies to other users", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });

    await service.sendTurn(profile, "hello", {
      async chat() {
        return {
          message: {
            content: JSON.stringify({
              replies: [
                { toUser: "alex", content: "woof for alex" },
                { toUser: "friend", content: "woof for friend" },
              ],
            }),
          },
        };
      },
    });

    expect(rooms.sentMessages).toHaveLength(3);
    expect(rooms.sentMessages[1]).toMatchObject({
      body: { userType: "dog", content: "woof for alex", toUser: "alex" },
      options: { threadUser: "alex" },
    });
    expect(rooms.sentMessages[2]).toMatchObject({
      body: { userType: "dog", content: "woof for friend", toUser: "friend" },
      options: { threadUser: "friend" },
    });
  });

  it("forces a reply to actor when AI omits it", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });

    await service.sendTurn(profile, "hello", {
      async chat() {
        return {
          message: {
            content: JSON.stringify({
              replies: [{ toUser: "friend", content: "hello friend" }],
            }),
          },
        };
      },
    });

    expect(rooms.sentMessages).toHaveLength(3);
    expect(rooms.sentMessages[1]).toMatchObject({
      body: { userType: "dog", content: "Rex barks in reply.", toUser: "alex" },
      options: { threadUser: "alex" },
    });
    expect(rooms.sentMessages[2]).toMatchObject({
      body: { userType: "dog", content: "hello friend", toUser: "friend" },
      options: { threadUser: "friend" },
    });
  });

  it("relinquish clears profile and stops polling", async () => {
    const rooms = new MockRooms();
    const kv = new MockKv();
    const timer = new MockTimer();
    const service = new WoofService(rooms, kv, timer);

    await service.enterChat({ dogName: "Rex" });

    service.startPolling(async () => undefined, 5000);
    await service.relinquish();

    expect(timer.clearCalls).toEqual([42]);
    await expect(loadStoredWorkerUrl(kv)).resolves.toBeNull();
  });
});
