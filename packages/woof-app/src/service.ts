import type {
  PuterFedRooms,
  Message,
  Room,
  RoomUser,
} from "puter-federation-sdk";
import type { AI, ChatMessage, ChatResponse, KV } from "@heyputer/puter.js";

import {
  clearProfile,
  loadStoredWorkerUrl,
  saveStoredWorkerUrl,
  type DogProfile,
} from "./profile";

type PollHandle = number;

interface TimerLike {
  setInterval(handler: () => void, ms: number): PollHandle;
  clearInterval(handle: PollHandle): void;
}

type RoomsLike = Pick<
  PuterFedRooms,
  | "createRoom"
  | "getRoom"
  | "joinRoom"
  | "whoAmI"
  | "parseInviteInput"
  | "getPublicKeyUrl"
  | "sendMessage"
  | "pollMessages"
  | "listMembers"
  | "createInviteToken"
  | "createInviteLink"
>;

type KvLike = Pick<KV, "get" | "set" | "del">;

type PuterAI = Pick<AI, "chat">;

export class WoofService {
  private pollHandle: PollHandle | null = null;

  constructor(
    private readonly rooms: RoomsLike,
    private readonly kv: KvLike,
    private readonly timer: TimerLike = {
      setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
      clearInterval: (handle) => globalThis.clearInterval(handle),
    },
  ) {}

  async restoreProfile(): Promise<DogProfile | null> {
    const workerUrl = await loadStoredWorkerUrl(this.kv);
    if (!workerUrl) {
      return null;
    }

    try {
      const room = await this.rooms.getRoom(workerUrl);
      return { room };
    } catch (error) {
      await clearProfile(this.kv);
      throw error;
    }
  }

  async enterChat(args: { dogName: string }): Promise<DogProfile> {
    const room = await this.rooms.createRoom(args.dogName);
    await saveStoredWorkerUrl(room, this.kv);
    return { room };
  }

  async joinFromInvite(inviteInput: string): Promise<DogProfile> {
    const parsed = this.rooms.parseInviteInput(inviteInput.trim());
    const room = await this.rooms.joinRoom(parsed.workerUrl, {
      inviteToken: parsed.inviteToken,
      publicKeyUrl: this.rooms.getPublicKeyUrl(),
    });

    await saveStoredWorkerUrl(room, this.kv);
    return { room };
  }

  async refreshProfileCanonical(profile: DogProfile): Promise<DogProfile> {
    try {
      const snapshot = await this.rooms.getRoom(profile.room.workerUrl);
      await saveStoredWorkerUrl(snapshot, this.kv);
      return { room: snapshot };
    } catch (error) {
      await clearProfile(this.kv);
      throw error;
    }
  }

  async generateInviteLink(room: Room): Promise<string> {
    const invite = await this.rooms.createInviteToken(room);
    return this.rooms.createInviteLink(room, invite.token);
  }

  async sendTurn(profile: DogProfile, content: string, puterAI?: PuterAI): Promise<void> {
    const actor = await this.rooms.whoAmI();

    await this.rooms.sendMessage(profile.room, {
      userType: "user",
      content,
    });

    const [messages, members] = await Promise.all([
      this.rooms.pollMessages(profile.room, 0, { scope: "global" }),
      this.rooms.listMembers(profile.room),
    ]);

    const replies = await this.getDogReplies({
      actor,
      userMessage: content,
      dogName: profile.room.name,
      messages,
      members,
      puterAI,
    });

    for (const reply of replies) {
      await this.rooms.sendMessage(
        profile.room,
        {
          userType: "dog",
          content: reply.content,
          toUser: reply.toUser,
        },
        {
          threadUser: reply.toUser,
        },
      );
    }
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

  async relinquish(): Promise<void> {
    this.stopPolling();
    await clearProfile(this.kv);
  }

  private async getDogReplies(args: {
    actor: RoomUser;
    userMessage: string;
    dogName: string;
    messages: Message[];
    members: string[];
    puterAI?: PuterAI;
  }): Promise<Array<{ toUser: string; content: string }>> {
    const fallbackToActor = () => [
      {
        toUser: args.actor.username,
        content: `${args.dogName} barks happily.`,
      },
    ];

    if (!args.puterAI?.chat) {
      return [
        {
          toUser: args.actor.username,
          content: `${args.dogName} tilts its head and wags.`,
        },
      ];
    }

    try {
      const response = await args.puterAI.chat(buildDogPrompt(args));

      const extracted = extractAIText(response);
      if (extracted) {
        const plan = parseDogReplyPlan(extracted);
        const sanitized = sanitizeDogReplyPlan(plan, args.members);

        if (sanitized.length > 0) {
          const hasActorReply = sanitized.some((item) => item.toUser === args.actor.username);
          if (hasActorReply) {
            return sanitized;
          }

          return [
            {
              toUser: args.actor.username,
              content: `${args.dogName} barks in reply.`,
            },
            ...sanitized,
          ];
        }

        return [
          {
            toUser: args.actor.username,
            content: extracted,
          },
        ];
      }

      console.warn("[woof-app] AI response had no usable text", { response });
      return fallbackToActor();
    } catch (error) {
      console.error("[woof-app] AI reply generation failed", {
        error,
        dogName: args.dogName,
      });
      return fallbackToActor();
    }
  }

}

function buildDogPrompt(args: {
  actor: RoomUser;
  userMessage: string;
  dogName: string;
  messages: Message[];
  members: string[];
}): ChatMessage[] {
  const normalizedHistory = args.messages
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((message) => {
      const payload = normalizeMessageBody(message.body);
      return {
        id: message.id,
        at: message.createdAt,
        fromUser: message.signedBy,
        toUser: message.threadUser ?? message.signedBy,
        userType: payload.userType,
        content: payload.content,
      };
    });

  return [
    {
      role: "system",
      content: [
        `You are ${args.dogName}, a friendly dog in a shared room with separate 1:1 threads.`,
        "You can reply to multiple users, but you must always reply to the trigger user.",
        "Return STRICT JSON only: {\"replies\":[{\"toUser\":\"username\",\"content\":\"message\"}]}",
        "Keep content short and playful.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        triggerUser: args.actor.username,
        latestUserMessage: args.userMessage,
        members: args.members,
        history: normalizedHistory,
      }),
    },
  ];
}

function normalizeMessageBody(body: Message["body"]): { userType: string; content: string } {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, Message["body"]>;
    return {
      userType: String(record.userType ?? "user"),
      content: String(record.content ?? ""),
    };
  }

  return {
    userType: "user",
    content: String(body),
  };
}

function parseDogReplyPlan(value: string): unknown {
  const trimmed = value.trim();
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const jsonText = fencedMatch ? fencedMatch[1] : trimmed;

  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function sanitizeDogReplyPlan(
  plan: unknown,
  roomMembers: string[],
): Array<{ toUser: string; content: string }> {
  if (!plan || typeof plan !== "object" || !("replies" in plan)) {
    return [];
  }

  const replies = (plan as { replies?: unknown }).replies;
  if (!Array.isArray(replies)) {
    return [];
  }

  const memberSet = new Set(roomMembers);
  const sanitized: Array<{ toUser: string; content: string }> = [];

  for (const item of replies) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const toUser = typeof (item as { toUser?: unknown }).toUser === "string"
      ? (item as { toUser: string }).toUser.trim()
      : "";
    const content = typeof (item as { content?: unknown }).content === "string"
      ? (item as { content: string }).content.trim()
      : "";

    if (!toUser || !content || !memberSet.has(toUser)) {
      continue;
    }

    sanitized.push({ toUser, content });
  }

  return sanitized;
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
