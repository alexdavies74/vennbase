import * as Y from "yjs";
import type {
  AnyRowHandle,
  PutBaseUser,
} from "@putbase/core";
import type { AI, ChatMessage, ChatResponse } from "@heyputer/puter.js";

import type { DogRowHandle, TagRowHandle, WoofDb, WoofSchema } from "./schema";

type PuterAI = Pick<AI, "chat">;

export type WoofDbPort = Pick<
  WoofDb,
  "whoAmI" | "put" | "query" | "update" | "listMembers"
>;

export interface ChatEntry {
  id: string;
  content: string;
  userType: "user" | "dog";
  threadUser: string | null;
  createdAt: number;
  signedBy: string;
}

function expectDogRow(row: AnyRowHandle<WoofSchema>): DogRowHandle {
  if (row.collection !== "dogs") {
    throw new Error(`Expected dogs row, got ${row.collection}`);
  }

  return row as DogRowHandle;
}

function getChatArray(doc: Y.Doc): Y.Array<ChatEntry> {
  return doc.getArray<ChatEntry>("messages");
}

export class WoofService {
  constructor(
    private readonly db: WoofDbPort,
  ) {}

  getChatEntries(doc: Y.Doc, username: string | null): ChatEntry[] {
    if (!username) {
      return [];
    }

    return getChatArray(doc).toArray().filter((entry) => entry.threadUser === username);
  }

  enterChat(args: { dogName: string }): DogRowHandle {
    const row = this.db.put("dogs", { name: args.dogName });
    this.activateHistory(row);
    return row;
  }

  expectDogRow(row: AnyRowHandle<WoofSchema>): DogRowHandle {
    return expectDogRow(row);
  }

  async sendTurn(
    row: DogRowHandle,
    args: { content: string; doc: Y.Doc; flush?: () => Promise<void>; puterAI?: PuterAI },
  ): Promise<void> {
    const actor = await this.db.whoAmI();
    const members = await this.db.listMembers(row.ref);
    const dogName = String(row.fields.name ?? "");
    const chatArray = getChatArray(args.doc);

    const userEntry: ChatEntry = {
      id: crypto.randomUUID(),
      content: args.content,
      userType: "user",
      threadUser: actor.username,
      createdAt: Date.now(),
      signedBy: actor.username,
    };

    args.doc.transact(() => {
      chatArray.push([userEntry]);
    });

    const replies = await this.getDogReplies({
      actor,
      dogName,
      entries: chatArray.toArray(),
      members,
      puterAI: args.puterAI,
    });

    if (replies.length > 0) {
      args.doc.transact(() => {
        const now = Date.now();
        chatArray.push(
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

    await args.flush?.();
  }

  async createTag(row: DogRowHandle, label: string): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed) {
      throw new Error("Tag text is required.");
    }

    if (trimmed.length > 32) {
      throw new Error("Tag text must be 32 characters or fewer.");
    }

    const actor = await this.db.whoAmI();
    await this.db.put(
      "tags",
      {
        label: trimmed,
        createdBy: actor.username,
        createdAt: Date.now(),
      },
      {
        in: row.ref,
      },
    );
  }

  async relinquish(): Promise<void> {
    await this.clearActiveHistory();
  }

  activateHistory(row: DogRowHandle): void {
    const historyRow = this.db.put("dogHistory", {
      dogRef: row.ref,
      status: "active",
    });
    void this.clearActiveHistory(historyRow.id).catch((error) => {
      console.error("[woof-app] failed to clear prior active dog history rows", {
        error,
        rowRef: row.ref,
      });
    });
  }

  private async clearActiveHistory(keepHistoryRowId?: string): Promise<void> {
    const activeHistoryRows = await this.db.query("dogHistory", {
      where: { status: "active" },
      limit: 20,
    });

    await Promise.all(
      activeHistoryRows.map((historyRow) =>
        historyRow.id === keepHistoryRowId
          ? Promise.resolve(historyRow)
          :
        this.db.update("dogHistory", historyRow.ref, { status: "inactive" })),
    );
  }

  private async getDogReplies(args: {
    actor: PutBaseUser;
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
  actor: PutBaseUser;
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
  rowMembers: string[],
): Array<{ toUser: string; content: string }> {
  if (!plan || typeof plan !== "object") {
    return [];
  }

  const record = plan as {
    triggerUserReply?: unknown;
    otherReplies?: unknown;
    replies?: unknown;
  };

  const memberSet = new Set(rowMembers);
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
