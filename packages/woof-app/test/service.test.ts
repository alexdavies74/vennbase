import { describe, expect, it } from "vitest";

import type { InviteToken, Message, Room } from "puter-federation-sdk";
import type { ChatMessage } from "@heyputer/puter.js";

import { loadProfile } from "../src/profile";
import { WoofService } from "../src/service";

class MockStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
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
  public sentMessages: Array<{ room: Room; body: Message["body"] }> = [];

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
    return {
      workerUrl: "https://workers.puter.site/alex/rooms/room_joined",
      inviteToken: input.includes("token") ? "invite_1" : undefined,
    };
  }

  getPublicKeyUrl(): string {
    return "https://keys.example/alex.json";
  }

  async sendMessage(room: Room, body: Message["body"]): Promise<void> {
    this.sentMessages.push({ room, body });
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
    return `https://woof.example/join?owner=${room.owner}&room=${room.id}&token=${inviteToken}`;
  }
}

describe("WoofService", () => {
  it("creates room on first-run adopt flow", async () => {
    const rooms = new MockRooms();
    const storage = new MockStorage();
    const service = new WoofService(rooms, storage);

    const profile = await service.enterChat({ dogName: "Rex" });

    expect(profile.room.id).toBe("room_created");
    expect(loadProfile(storage)?.dogName).toBe("Rex");
  });

  it("joins room from invite input", async () => {
    const rooms = new MockRooms();
    const storage = new MockStorage();
    const service = new WoofService(rooms, storage);

    const profile = await service.enterChat({
      dogName: "Rex",
      inviteInput: "https://woof.example/join?owner=alex&room=room_joined&token=invite_1",
    });

    expect(profile.room.id).toBe("room_joined");
  });

  it("sends user and dog messages in one turn", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockStorage());
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
    expect(rooms.sentMessages[1].body).toEqual({ userType: "dog", content: "woof!" });
    expect(chatInput).toEqual([
      {
        role: "system",
        content: "You are Rex, a friendly dog replying in short playful lines.",
      },
      {
        role: "user",
        content: "hello",
      },
    ]);
  });

  it("falls back to canned dog reply when AI call fails", async () => {
    const rooms = new MockRooms();
    const service = new WoofService(rooms, new MockStorage());

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
    });
  });

  it("relinquish clears profile and stops polling", async () => {
    const rooms = new MockRooms();
    const storage = new MockStorage();
    const timer = new MockTimer();
    const service = new WoofService(rooms, storage, timer);

    await service.enterChat({ dogName: "Rex" });

    service.startPolling(async () => undefined, 5000);
    service.relinquish();

    expect(timer.clearCalls).toEqual([42]);
    expect(loadProfile(storage)).toBeNull();
  });
});
