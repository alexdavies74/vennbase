import * as Y from "yjs";
import type {
  DbRowRef,
  PuterFedRooms,
  CrdtConnection,
  JsonValue,
  Room,
  RoomUser,
} from "puter-federation-sdk";
import { resolveWorkerUrl } from "puter-federation-sdk";
import type { AI, ChatMessage, ChatResponse, KV } from "@heyputer/puter.js";

import {
  clearProfile,
  loadStoredWorkerUrl,
  saveStoredWorkerUrl,
  type DogProfile,
} from "./profile";

type RoomsLike = Pick<
  PuterFedRooms,
  | "createRoom"
  | "getRoom"
  | "joinRoom"
  | "whoAmI"
  | "parseInviteInput"
  | "listMembers"
  | "createInviteToken"
  | "createInviteLink"
  | "connectCrdt"
>;

type KvLike = Pick<KV, "get" | "set" | "del">;

type PuterAI = Pick<AI, "chat">;

interface TagRowLike {
  id: string;
  fields: Record<string, JsonValue>;
}

interface TagDbLike {
  insert(
    collection: "tags",
    fields: Record<string, JsonValue>,
    options: { in: DbRowRef },
  ): Promise<unknown>;
  query(
    collection: "tags",
    options: {
      in: DbRowRef;
      index?: string;
      order?: "asc" | "desc";
      limit?: number;
      where?: Record<string, JsonValue>;
    },
  ): Promise<TagRowLike[]>;
}

export interface ChatEntry {
  id: string;
  content: string;
  userType: "user" | "dog";
  threadUser: string | null;
  createdAt: number;
  signedBy: string;
}

export interface DogTag {
  id: string;
  label: string;
  createdBy: string | null;
  createdAt: number | null;
}

function encodeUpdate(update: Uint8Array): { type: string; data: string } {
  return {
    type: "yjs-update",
    data: btoa(Array.from(update, (b) => String.fromCharCode(b)).join("")),
  };
}

function decodeUpdate(body: unknown): Uint8Array | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.type !== "yjs-update" || typeof record.data !== "string") {
    return null;
  }
  try {
    const binary = atob(record.data);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export class WoofService {
  private connection: CrdtConnection | null = null;
  private pendingUpdate: Uint8Array | null = null;

  constructor(
    private readonly rooms: RoomsLike,
    private readonly kv: KvLike,
    private readonly doc: Y.Doc = new Y.Doc(),
    private readonly db: TagDbLike | null = null,
  ) {
    this.doc.on("update", (update: Uint8Array) => {
      this.pendingUpdate = this.pendingUpdate
        ? Y.mergeUpdates([this.pendingUpdate, update])
        : update;
    });
  }

  get chatArray(): Y.Array<ChatEntry> {
    return this.doc.getArray<ChatEntry>("messages");
  }

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

  connectToRoom(profile: DogProfile): void {
    this.connection?.disconnect();
    this.connection = this.rooms.connectCrdt(profile.room, {
      applyRemoteUpdate: (body) => {
        const update = decodeUpdate(body);
        if (update) {
          Y.applyUpdate(this.doc, update);
        }
      },
      produceLocalUpdate: () => {
        const update = this.pendingUpdate;
        this.pendingUpdate = null;
        return update ? encodeUpdate(update) : null;
      },
    });
  }

  async sendTurn(profile: DogProfile, content: string, puterAI?: PuterAI): Promise<void> {
    const actor = await this.rooms.whoAmI();
    const members = await this.rooms.listMembers(profile.room);

    const userEntry: ChatEntry = {
      id: crypto.randomUUID(),
      content,
      userType: "user",
      threadUser: actor.username,
      createdAt: Date.now(),
      signedBy: actor.username,
    };

    this.doc.transact(() => {
      this.chatArray.push([userEntry]);
    });

    const replies = await this.getDogReplies({
      actor,
      dogName: profile.room.name,
      entries: this.chatArray.toArray(),
      members,
      puterAI,
    });

    if (replies.length > 0) {
      this.doc.transact(() => {
        const now = Date.now();
        this.chatArray.push(
          replies.map((reply, i) => ({
            id: crypto.randomUUID(),
            content: reply.content,
            userType: "dog" as const,
            threadUser: reply.toUser,
            createdAt: now + i,
            signedBy: actor.username,
          })),
        );
      });
    }

    await this.connection?.flush();
  }

  async listTags(profile: DogProfile): Promise<DogTag[]> {
    if (!this.db) {
      return [];
    }

    const rows = await this.db.query("tags", {
      in: this.dogRowRef(profile),
      index: "byCreatedAt",
      order: "asc",
      limit: 100,
    });

    const tags: DogTag[] = rows
      .map((row) => {
        const label = typeof row.fields.label === "string"
          ? row.fields.label.trim()
          : "";
        if (!label) {
          return null;
        }

        return {
          id: row.id,
          label,
          createdBy: typeof row.fields.createdBy === "string"
            ? row.fields.createdBy
            : null,
          createdAt: typeof row.fields.createdAt === "number"
            ? row.fields.createdAt
            : null,
        } satisfies DogTag;
      })
      .filter((row): row is DogTag => row !== null);

    return tags;
  }

  async createTag(profile: DogProfile, label: string): Promise<void> {
    if (!this.db) {
      throw new Error("Tag database is unavailable.");
    }

    const trimmed = label.trim();
    if (!trimmed) {
      throw new Error("Tag text is required.");
    }

    if (trimmed.length > 32) {
      throw new Error("Tag text must be 32 characters or fewer.");
    }

    const actor = await this.rooms.whoAmI();
    await this.db.insert(
      "tags",
      {
        label: trimmed,
        createdBy: actor.username,
        createdAt: Date.now(),
      },
      {
        in: this.dogRowRef(profile),
      },
    );
  }

  async relinquish(): Promise<void> {
    this.connection?.disconnect();
    this.connection = null;
    await clearProfile(this.kv);
  }

  private dogRowRef(profile: DogProfile): DbRowRef {
    return {
      id: profile.room.id,
      collection: "dogs",
      owner: profile.room.owner,
      workerUrl: resolveWorkerUrl(profile.room.owner, profile.room.id),
    };
  }

  private async getDogReplies(args: {
    actor: RoomUser;
    dogName: string;
    entries: ChatEntry[];
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
      console.log({response});

      const extracted = extractAIText(response);
      if (extracted) {
        const plan = parseDogReplyPlan(extracted);
        const sanitized = sanitizeDogReplyPlan(plan, args.actor.username, args.members);

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
            content: stripConversationAddressPrefix(extracted) || extracted,
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
  dogName: string;
  entries: ChatEntry[];
  members: string[];
}): ChatMessage[] {
  const sortedEntries = [...args.entries].sort(
    (left, right) => left.createdAt - right.createdAt,
  );

  const promptPieces: ChatMessage[] = [
    {
      role: "system",
      content: [
        `You are ${args.dogName}, a friendly dog in a shared room with separate 1:1 threads.`,
        "You can reply to multiple users, but you must always reply to the trigger user.",
        "Return STRICT JSON only: {\"triggerUserReply\":\"message\",\"otherReplies\":[{\"toUser\":\"username\",\"content\":\"message\"}]}",
        "Keep content short and playful.",
      ].join(" "),
    },
    {
      role: "system",
      content: `Room members: ${args.members.join(", ")}. Trigger user: ${args.actor.username}.`,
    },
    ...sortedEntries.map((entry) => {
      const fromUser = entry.userType === "dog" ? args.dogName : entry.signedBy;
      const toUser = entry.userType === "dog"
        ? (entry.threadUser ?? args.actor.username)
        : args.dogName;
      return {
        role: entry.userType === "dog" ? "assistant" : "user",
        content: `[${fromUser} \u2192 ${toUser}] ${entry.content}`,
      };
    }),
  ];

  console.log({promptPieces});

  return promptPieces;
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
  triggerUser: string,
  roomMembers: string[],
): Array<{ toUser: string; content: string }> {
  if (!plan || typeof plan !== "object") {
    return [];
  }

  const record = plan as {
    triggerUserReply?: unknown;
    otherReplies?: unknown;
    replies?: unknown;
  };

  const memberSet = new Set(roomMembers);
  const sanitized: Array<{ toUser: string; content: string }> = [];

  const triggerUserReply =
    typeof record.triggerUserReply === "string"
      ? stripConversationAddressPrefix(record.triggerUserReply)
      : "";
  if (triggerUserReply && memberSet.has(triggerUser)) {
    sanitized.push({ toUser: triggerUser, content: triggerUserReply });
  }

  const otherReplies = Array.isArray(record.otherReplies)
    ? record.otherReplies
    : Array.isArray(record.replies)
      ? record.replies
      : [];

  for (const item of otherReplies) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const toUser = typeof (item as { toUser?: unknown }).toUser === "string"
      ? (item as { toUser: string }).toUser.trim()
      : "";
    const content = typeof (item as { content?: unknown }).content === "string"
      ? stripConversationAddressPrefix((item as { content: string }).content)
      : "";

    if (!toUser || !content || !memberSet.has(toUser) || toUser === triggerUser) {
      continue;
    }

    sanitized.push({ toUser, content });
  }

  return sanitized;
}

function stripConversationAddressPrefix(content: string): string {
  return content
    .trim()
    .replace(/^\[[^\]\r\n]+(?:\u2192|->)[^\]\r\n]+\]\s*/u, "")
    .trim();
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
