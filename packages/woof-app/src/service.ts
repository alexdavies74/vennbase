import type {
  PuterFedRooms,
  Room,
} from "puter-federation-sdk";
import type { AI, ChatResponse } from "@heyputer/puter.js";

import { clearProfile, loadProfile, saveProfile, type DogProfile } from "./profile";

type PollHandle = number;

interface TimerLike {
  setInterval(handler: () => void, ms: number): PollHandle;
  clearInterval(handle: PollHandle): void;
}

type RoomsLike = Pick<
  PuterFedRooms,
  | "createRoom"
  | "joinRoom"
  | "parseInviteInput"
  | "getPublicKeyUrl"
  | "sendMessage"
  | "createInviteToken"
  | "createInviteLink"
>;

type PuterAI = Pick<AI, "chat">;

export class WoofService {
  private pollHandle: PollHandle | null = null;

  constructor(
    private readonly rooms: RoomsLike,
    private readonly storage: Storage = localStorage,
    private readonly timer: TimerLike = {
      setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
      clearInterval: (handle) => globalThis.clearInterval(handle),
    },
  ) {}

  restoreProfile(): DogProfile | null {
    return loadProfile(this.storage);
  }

  async enterChat(args: { dogName: string; inviteInput?: string }): Promise<DogProfile> {
    const inviteInput = args.inviteInput?.trim();

    const room = inviteInput
      ? await this.joinExistingRoom(inviteInput)
      : await this.rooms.createRoom(args.dogName);

    const profile: DogProfile = {
      dogName: args.dogName,
      room,
    };

    saveProfile(profile, this.storage);
    return profile;
  }

  async generateInviteLink(room: Room): Promise<string> {
    const invite = await this.rooms.createInviteToken(room);
    return this.rooms.createInviteLink(room, invite.token);
  }

  async sendTurn(profile: DogProfile, content: string, puterAI?: PuterAI): Promise<void> {
    await this.rooms.sendMessage(profile.room, {
      userType: "user",
      content,
    });

    const dogReply = await this.getDogReply(content, profile.dogName, puterAI);

    await this.rooms.sendMessage(profile.room, {
      userType: "dog",
      content: dogReply,
    });
  }

  startPolling(callback: () => Promise<void>, intervalMs = 5000): void {
    this.stopPolling();
    this.pollHandle = this.timer.setInterval(() => {
      callback().catch(() => {
        // Keep polling alive across transient failures.
      });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollHandle !== null) {
      this.timer.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  relinquish(): void {
    this.stopPolling();
    clearProfile(this.storage);
  }

  private async joinExistingRoom(inviteInput: string): Promise<Room> {
    const parsed = this.rooms.parseInviteInput(inviteInput);
    return this.rooms.joinRoom(parsed.workerUrl, {
      inviteToken: parsed.inviteToken,
      publicKeyUrl: this.rooms.getPublicKeyUrl(),
    });
  }

  private async getDogReply(
    userMessage: string,
    dogName: string,
    puterAI?: PuterAI,
  ): Promise<string> {
    if (!puterAI?.chat) {
      return `${dogName} tilts its head and wags.`;
    }

    try {
      const response = await puterAI.chat([
        {
          role: "system",
          content: `You are ${dogName}, a friendly dog replying in short playful lines.`,
        },
        {
          role: "user",
          content: userMessage,
        },
      ]);

      const extracted = extractAIText(response);
      if (extracted) {
        return extracted;
      }

      console.warn("[woof-app] AI response had no usable text", { response });
      return `${dogName} barks happily.`;
    } catch (error) {
      console.error("[woof-app] AI reply generation failed", {
        error,
        dogName,
      });
      return `${dogName} barks happily.`;
    }
  }
}

function extractAIText(response: ChatResponse): string | null {
  const content = response.message?.content;
  if (content == null) {
    return null;
  }

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (content && typeof content === "object") {
    const maybeText = (content as Record<string, unknown>).text;
    if (typeof maybeText === "string" && maybeText.trim()) {
      return maybeText.trim();
    }
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object") {
          const maybeText = (part as Record<string, unknown>).text;
          return typeof maybeText === "string" ? maybeText : "";
        }

        return "";
      })
      .filter((part) => part.length > 0)
      .join(" ")
      .trim();

    return joined || null;
  }

  return null;
}
