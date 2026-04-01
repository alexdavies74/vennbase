import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createYjsAdapter } from "@vennbase/yjs";

import {
  CURRENT_USER,
  RowHandle,
  CrdtConnectCallbacks,
  CrdtConnection,
  VENNBASE_INVITE_TARGET_PARAM,
} from "@vennbase/core";
import type {
  DbMemberInfo,
  MemberRole,
  MutationReceipt,
  RowRef,
  RowHandleBackend,
} from "@vennbase/core";
import type { ChatMessage } from "@heyputer/puter.js";

import type {
  DogHistoryFields,
  DogHistoryRowHandle,
  DogFields,
  DogRowHandle,
  TagFields,
  TagRowHandle,
  WoofSchema,
} from "../src/schema";
import { WoofService, type ChatEntry, type WoofDbPort } from "../src/service";

function committedReceipt<TValue>(value: TValue): MutationReceipt<TValue> {
  return {
    value,
    committed: Promise.resolve(value),
    status: "committed",
    error: undefined,
  };
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
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function rowUrl(row: RowRef): string {
  return `${row.baseUrl}/rows/${row.id}`;
}

function dogRef(id: string): RowRef<"dogs"> {
  return {
    id,
    collection: "dogs",
    baseUrl: "https://workers.puter.site/alex",
  };
}

function tagRef(id: string): RowRef<"tags"> {
  return {
    id,
    collection: "tags",
    baseUrl: "https://workers.puter.site/alex",
  };
}

function dogHistoryRef(id: string): RowRef<"dogHistory"> {
  return {
    id,
    collection: "dogHistory",
    baseUrl: "https://workers.puter.site/alex",
  };
}

function shareLink(rowId: string): string {
  return `https://woof.example/?${VENNBASE_INVITE_TARGET_PARAM}=${encodeURIComponent(JSON.stringify({
    ref: dogRef(rowId),
    shareToken: "invite_1",
  }))}`;
}

class MockDb implements WoofDbPort {
  public readonly memberList = ["alex", "friend"];
  public crdtCallbacks: CrdtConnectCallbacks | null = null;

  public createCalls: Array<{
    collection: string;
    fields: Record<string, unknown>;
    options?: { in?: RowRef<"dogs"> | typeof CURRENT_USER };
  }> = [];

  private readonly rowFields = new Map<string, Record<string, unknown>>();
  private readonly historyRows = new Map<string, DogHistoryRowHandle>();
  private readonly rowDocs = new Map<string, Y.Doc>();
  private createdDogCount = 0;

  private readonly backend: RowHandleBackend<WoofSchema> = {
    addParent: () => committedReceipt(undefined),
    removeParent: () => committedReceipt(undefined),
    listParents: async <TParentCollection extends string>() => [] as Array<RowRef<TParentCollection>>,
    addMember: () => committedReceipt(undefined),
    removeMember: () => committedReceipt(undefined),
    listDirectMembers: async () => this.memberList.map((username) => ({
      username,
      role: this.roleFor(username),
    })),
    listEffectiveMembers: async () => this.memberList.map((username) => ({
      username,
      role: this.roleFor(username),
      via: "direct",
    })) as Array<DbMemberInfo<WoofSchema>>,
    refreshFields: async (row: RowRef) => this.readFields(row.id),
    connectCrdt: (row: RowRef, callbacks: CrdtConnectCallbacks): CrdtConnection => {
      this.crdtCallbacks = callbacks;
      const storedDoc = this.getRowDoc(rowUrl(row));
      const storedMessages = storedDoc.getArray("messages");
      if (storedMessages.length > 0) {
        const update = Y.encodeStateAsUpdate(storedDoc);
        callbacks.applyRemoteUpdate(encodeUpdate(update), {
          id: "msg_restore",
          rowId: row.id,
          body: encodeUpdate(update),
          createdAt: Date.now(),
          signedBy: "alex",
          sequence: 1,
        });
      }
      return {
        disconnect: () => undefined,
        flush: async () => {
          const update = callbacks.produceLocalUpdate();
          const decoded = decodeUpdate(update);
          if (!decoded) {
            return;
          }

          Y.applyUpdate(this.getRowDoc(rowUrl(row)), decoded, "local-test");
        },
      };
    },
    listMembers: async () => this.memberList,
  };

  private roleFor(username: string): MemberRole {
    return username === "alex" ? "editor" : "viewer";
  }

  private readFields(id: string): Record<string, unknown> {
    return this.rowFields.get(id) ?? {};
  }

  private getRowDoc(target: string): Y.Doc {
    const existing = this.rowDocs.get(target);
    if (existing) {
      return existing;
    }

    const doc = new Y.Doc();
    this.rowDocs.set(target, doc);
    return doc;
  }

  private makeDogRow(id: string, fields: Record<string, unknown>): DogRowHandle {
    const rowRef = dogRef(id);
    const rowFields: DogFields = {
      name: typeof fields.name === "string" ? fields.name : "",
    };
    this.rowFields.set(id, rowFields);
    return new RowHandle(this.backend, rowRef, "alex", rowFields);
  }

  private makeTagRow(id: string, fields: Record<string, unknown>): TagRowHandle {
    const rowRef = tagRef(id);
    const rowFields: TagFields = {
      label: typeof fields.label === "string" ? fields.label : "",
      createdBy: typeof fields.createdBy === "string" ? fields.createdBy : "",
      createdAt: typeof fields.createdAt === "number" ? fields.createdAt : 0,
    };
    this.rowFields.set(id, rowFields);
    return new RowHandle(this.backend, rowRef, "alex", rowFields);
  }

  private makeDogHistoryRow(id: string, fields: Record<string, unknown>): DogHistoryRowHandle {
    const rowRef = dogHistoryRef(id);
    const rowFields: DogHistoryFields = {
      dogRef: fields.dogRef as RowRef<"dogs"> ?? dogRef("row_created"),
      status: typeof fields.status === "string" ? fields.status : "inactive",
    };
    const row = new RowHandle(this.backend, rowRef, "alex", rowFields);
    this.rowFields.set(id, rowFields);
    this.historyRows.set(id, row);
    return row;
  }

  async whoAmI(): Promise<{ username: string }> {
    return { username: "alex" };
  }

  create(collection: "dogs", fields: DogRowHandle["fields"]): MutationReceipt<DogRowHandle>;
  create(
    collection: "dogHistory",
    fields: DogHistoryRowHandle["fields"],
    options: { in: typeof CURRENT_USER },
  ): MutationReceipt<DogHistoryRowHandle>;
  create(
    collection: "tags",
    fields: TagRowHandle["fields"],
    options: { in: RowRef<"dogs"> },
  ): MutationReceipt<TagRowHandle>;
  create(
    collection: "dogs" | "dogHistory" | "tags",
    fields: Record<string, unknown>,
    options?: { in?: RowRef<"dogs"> | typeof CURRENT_USER },
  ): MutationReceipt<DogRowHandle> | MutationReceipt<DogHistoryRowHandle> | MutationReceipt<TagRowHandle> {
    this.createCalls.push({ collection, fields, options });
    if (collection === "dogs") {
      this.createdDogCount += 1;
      const id = this.createdDogCount === 1 ? "row_created" : `row_created_${this.createdDogCount}`;
      return committedReceipt(this.makeDogRow(id, fields));
    }

    if (collection === "dogHistory") {
      return committedReceipt(this.makeDogHistoryRow(`history_${this.createCalls.length}`, fields));
    }

    return committedReceipt(this.makeTagRow(`tag_${this.createCalls.length}`, fields));
  }

  async query(
    collection: "dogHistory",
    options: { in?: typeof CURRENT_USER; where?: { status?: string }; index?: "byDogRef"; value?: RowRef<"dogs">; limit?: number },
  ): Promise<DogHistoryRowHandle[]> {
    const rows = Array.from(this.historyRows.values());
    const filtered = options.index === "byDogRef"
      ? rows.filter((row) =>
        row.fields.dogRef.id === options.value?.id
        && row.fields.dogRef.baseUrl === options.value.baseUrl)
      : options.where?.status
        ? rows.filter((row) => row.fields.status === options.where?.status)
        : rows;
    return filtered.slice(0, options.limit ?? filtered.length);
  }

  update(
    collection: "dogHistory",
    row: RowRef<"dogHistory">,
    fields: Partial<DogHistoryFields>,
  ): MutationReceipt<DogHistoryRowHandle> {
    const existing = this.historyRows.get(row.id);
    if (!existing || collection !== "dogHistory") {
      throw new Error("history row missing");
    }

    existing.fields = {
      ...existing.fields,
      ...fields,
    };
    this.rowFields.set(row.id, existing.fields);
    return committedReceipt(existing);
  }

  async acceptInvite(_input: string): Promise<DogRowHandle> {
    return this.makeDogRow("row_joined", { name: "Joined" });
  }

  async listMembers(_row: RowRef): Promise<string[]> {
    return this.memberList;
  }
}

function chatEntries(doc: Y.Doc): ChatEntry[] {
  return doc.getArray<ChatEntry>("messages").toArray();
}

function connectDoc(row: DogRowHandle) {
  const binding = createYjsAdapter(Y);
  const connection = row.connectCrdt(binding.callbacks);
  return {
    binding,
    connection,
    doc: binding.getValue(),
    flush: async () => connection.flush(),
  };
}

describe("WoofService", () => {
  it("creates row on first-run adopt flow", async () => {
    const db = new MockDb();
    const service = new WoofService(db);

    const row = service.enterChat({ dogName: "Rex" });

    expect(row.id).toBe("row_created");
    expect(row.ref).toEqual(dogRef("row_created"));
  });

  it("narrows app rows to dogs rows", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await db.acceptInvite(
      shareLink("row_joined"),
    );

    expect(service.expectDogRow(row).id).toBe("row_joined");
    expect(String(service.expectDogRow(row).fields.name)).toBe("Joined");
  });

  it("creates tags as DB child rows under the dog row", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = service.enterChat({ dogName: "Rex" });

    await service.createTag(row, "friendly");

    const tagCall = db.createCalls.find((c) => c.collection === "tags");
    expect(tagCall).toBeDefined();
    expect(tagCall!.fields.label).toBe("friendly");
    expect(tagCall!.options?.in).toMatchObject({
      id: row.id,
      collection: "dogs",
      baseUrl: row.ref.baseUrl,
    });
  });

  it("sends user and dog messages in one turn", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    let chatInput: ChatMessage[] | undefined;

    const row = await service.enterChat({ dogName: "Rex" });
    const connected = connectDoc(row);

    await service.sendTurn(row, {
      content: "hello",
      doc: connected.doc,
      flush: connected.flush,
      puterAI: {
        async chat(input: ChatMessage[]) {
          chatInput = input;
          return { message: { content: "woof!" } };
        },
      },
    });

    const entries = chatEntries(connected.doc);
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
      content: "[alex → Rex] hello",
    });

    connected.connection.disconnect();
  });

  it("uses row field name for dog persona", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    let chatInput: ChatMessage[] | undefined;

    const row = await db.acceptInvite(
      shareLink("row_joined"),
    );
    const connected = connectDoc(row);

    await service.sendTurn(row, {
      content: "hello",
      doc: connected.doc,
      flush: connected.flush,
      puterAI: {
        async chat(input: ChatMessage[]) {
          chatInput = input;
          return { message: { content: "woof!" } };
        },
      },
    });

    expect(chatInput?.[0]).toEqual({
      role: "system",
      content:
        "You are Joined, a friendly dog in a shared room with separate 1:1 threads. You can reply to multiple users, but you must always reply to the trigger user. Return STRICT JSON only: {\"triggerUserReply\":\"message\",\"otherReplies\":[{\"toUser\":\"username\",\"content\":\"message\"}]} Keep content short and playful.",
    });

    connected.connection.disconnect();
  });

  it("formats history as chronological user and assistant messages", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    const connected = connectDoc(row);
    let secondTurnChatInput: ChatMessage[] | undefined;

    await service.sendTurn(row, {
      content: "first",
      doc: connected.doc,
      flush: connected.flush,
      puterAI: {
        async chat() {
          return { message: { content: JSON.stringify({ triggerUserReply: "first bark" }) } };
        },
      },
    });

    await service.sendTurn(row, {
      content: "second",
      doc: connected.doc,
      flush: connected.flush,
      puterAI: {
        async chat(input: ChatMessage[]) {
          secondTurnChatInput = input;
          return { message: { content: "second bark" } };
        },
      },
    });

    expect(secondTurnChatInput?.slice(2)).toEqual([
      { role: "user", content: "[alex → Rex] first" },
      { role: "assistant", content: "[Rex → alex] first bark" },
      { role: "user", content: "[alex → Rex] second" },
    ]);

    connected.connection.disconnect();
  });

  it("falls back to canned dog reply when AI call fails", async () => {
    const db = new MockDb();
    const service = new WoofService(db);

    const row = await service.enterChat({ dogName: "Rex" });
    const connected = connectDoc(row);

    await service.sendTurn(row, {
      content: "hello",
      doc: connected.doc,
      flush: connected.flush,
      puterAI: {
        async chat() { throw { message: "messages required" }; },
      },
    });

    const entries = chatEntries(connected.doc);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ userType: "user", content: "hello" });
    expect(entries[1]).toMatchObject({ userType: "dog", content: "Rex barks happily.", threadUser: "alex" });

    connected.connection.disconnect();
  });

  it("can send additional dog replies to other users", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    const connected = connectDoc(row);

    await service.sendTurn(row, {
      content: "hello",
      doc: connected.doc,
      flush: connected.flush,
      puterAI: {
        async chat() {
          return {
            message: {
              content: JSON.stringify({
                triggerUserReply: "[Rex → alex] woof for alex",
                otherReplies: [{ toUser: "friend", content: "[Rex → friend] woof for friend" }],
              }),
            },
          };
        },
      },
    });

    const entries = chatEntries(connected.doc);
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "woof for alex", threadUser: "alex" });
    expect(entries[2]).toMatchObject({ userType: "dog", content: "woof for friend", threadUser: "friend" });

    connected.connection.disconnect();
  });

  it("strips address prefix from plain-text AI replies", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    const connected = connectDoc(row);

    await service.sendTurn(row, {
      content: "hello",
      doc: connected.doc,
      flush: connected.flush,
      puterAI: {
        async chat() {
          return { message: { content: "[Rex → alex] plain woof" } };
        },
      },
    });

    const entries = chatEntries(connected.doc);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "plain woof", threadUser: "alex" });

    connected.connection.disconnect();
  });

  it("forces a reply to actor when AI omits it", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    const connected = connectDoc(row);

    await service.sendTurn(row, {
      content: "hello",
      doc: connected.doc,
      flush: connected.flush,
      puterAI: {
        async chat() {
          return {
            message: {
              content: JSON.stringify({ otherReplies: [{ toUser: "friend", content: "hello friend" }] }),
            },
          };
        },
      },
    });

    const entries = chatEntries(connected.doc);
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "Rex barks in reply.", threadUser: "alex" });
    expect(entries[2]).toMatchObject({ userType: "dog", content: "hello friend", threadUser: "friend" });

    connected.connection.disconnect();
  });

  it("relinquish only clears active history rows", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    const connected = connectDoc(row);
    await service.sendTurn(row, {
      content: "hello",
      doc: connected.doc,
      flush: connected.flush,
    });

    await service.relinquish();

    expect(chatEntries(connected.doc)).toHaveLength(2);

    connected.connection.disconnect();
  });

  it("clears local CRDT state when switching to a different dog row", async () => {
    const db = new MockDb();
    const service = new WoofService(db);

    const firstRow = service.enterChat({ dogName: "Rex" });
    const firstConnected = connectDoc(firstRow);
    await service.sendTurn(firstRow, {
      content: "hello",
      doc: firstConnected.doc,
      flush: firstConnected.flush,
    });
    expect(chatEntries(firstConnected.doc)).toHaveLength(2);

    const secondRow = service.enterChat({ dogName: "Fido" });
    firstConnected.connection.disconnect();
    firstConnected.binding.reset();
    const secondConnected = connectDoc(secondRow);

    expect(secondRow.id).not.toBe(firstRow.id);
    expect(chatEntries(firstConnected.binding.getValue())).toEqual([]);

    await service.sendTurn(secondRow, {
      content: "fresh start",
      doc: secondConnected.doc,
      flush: secondConnected.flush,
    });
    expect(chatEntries(secondConnected.doc)).toHaveLength(2);

    const restored = connectDoc(secondRow);

    expect(chatEntries(restored.doc)).toHaveLength(2);
    expect(chatEntries(restored.doc).every((entry) => entry.content !== "hello")).toBe(true);
    expect(chatEntries(restored.doc)[0]).toMatchObject({ content: "fresh start" });

    secondConnected.connection.disconnect();
    restored.connection.disconnect();
  });

  it("applies remote CRDT updates via applyRemoteUpdate callback", async () => {
    const db = new MockDb();
    const service = new WoofService(db);

    const row = await service.enterChat({ dogName: "Rex" });
    const connected = connectDoc(row);

    const remoteDoc = new Y.Doc();
    const remoteArray = remoteDoc.getArray<{
      id: string; content: string; userType: string;
      threadUser: string | null; createdAt: number; signedBy: string;
    }>("messages");
    remoteArray.push([{
      id: "remote_1",
      content: "hello from remote",
      userType: "user",
      threadUser: null,
      createdAt: 100,
      signedBy: "friend",
    }]);

    const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);
    const encodedBody = {
      type: "yjs-update",
      data: btoa(Array.from(remoteUpdate, (b) => String.fromCharCode(b)).join("")),
    };

    db.crdtCallbacks!.applyRemoteUpdate(encodedBody, {
      id: "msg_remote",
      rowId: "row_created",
      body: encodedBody,
      createdAt: 100,
      signedBy: "friend",
      sequence: 1,
    });

    const entries = chatEntries(connected.doc);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ content: "hello from remote", signedBy: "friend" });

    connected.connection.disconnect();
  });
});
