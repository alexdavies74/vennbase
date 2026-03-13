import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type {
  CrdtConnectCallbacks,
  CrdtConnection,
  DbMemberInfo,
  DbQueryWatchCallbacks,
  DbQueryWatchHandle,
  DbRowRef,
  InviteToken,
  MemberRole,
} from "puter-federation-sdk";
import { RowHandle } from "puter-federation-sdk";
import type { ChatMessage } from "@heyputer/puter.js";

import { loadStoredWorkerUrl } from "../src/profile";
import type { DogRowHandle, TagRowHandle, WoofDb } from "../src/schema";
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

type MockRow = { id: string; fields: Record<string, unknown> };

class MockDb {
  public failGetRowByUrl = false;
  public readonly memberList = ["alex", "friend"];
  public crdtCallbacks: CrdtConnectCallbacks | null = null;

  public putCalls: Array<{
    collection: string;
    fields: Record<string, unknown>;
    options?: { in?: DbRowRef<"dogs"> };
  }> = [];

  public queryRows: MockRow[] = [];
  public refreshCalls = 0;
  public disconnectCalls = 0;
  public watchCallbacks: DbQueryWatchCallbacks<MockRow> | null = null;

  private makeDogRow(id: string, fields: Record<string, unknown>): DogRowHandle {
    const workerUrl = `https://workers.puter.site/alex/rooms/${id}`;
    return new RowHandle(this as unknown as Parameters<typeof RowHandle>[0], {
      id,
      collection: "dogs",
      owner: "alex",
      workerUrl,
    }, fields as DogRowHandle["fields"]);
  }

  private makeTagRow(id: string, fields: Record<string, unknown>): TagRowHandle {
    const workerUrl = `https://workers.puter.site/alex/rooms/${id}`;
    return new RowHandle(this as unknown as Parameters<typeof RowHandle>[0], {
      id,
      collection: "tags",
      owner: "alex",
      workerUrl,
    }, fields as TagRowHandle["fields"]);
  }

  async whoAmI(): Promise<{ username: string }> {
    return { username: "alex" };
  }

  async put(
    collection: string,
    fields: Record<string, unknown>,
    options?: { in?: DbRowRef<"dogs"> },
  ): Promise<DogRowHandle | TagRowHandle> {
    this.putCalls.push({ collection, fields, options });
    const id = collection === "dogs" ? "row_created" : `tag_${this.putCalls.length}`;
    return collection === "dogs"
      ? this.makeDogRow(id, fields)
      : this.makeTagRow(id, fields);
  }

  async getRowByUrl(workerUrl: string): Promise<DogRowHandle> {
    if (this.failGetRowByUrl) {
      throw new Error("room lookup failed");
    }
    const joined = workerUrl.includes("row_joined");
    const id = joined ? "row_joined" : "row_created";
    const name = joined ? "Joined Canonical" : "Rex Canonical";
    return this.makeDogRow(id, { name });
  }

  parseInviteInput(input: string): { workerUrl: string; inviteToken?: string } {
    const url = new URL(input);
    const workerUrl = url.searchParams.get("worker");
    const token = url.searchParams.get("token") ?? undefined;
    return {
      workerUrl: workerUrl ?? `https://workers.puter.site/alex/rooms/row_joined`,
      inviteToken: token,
    };
  }

  async joinRow(
    workerUrl: string,
    _options?: { inviteToken?: string },
  ): Promise<DogRowHandle> {
    void workerUrl;
    return this.makeDogRow("row_joined", { name: "Joined" });
  }

  async query(_collection: string, _options?: unknown): Promise<TagRowHandle[]> {
    return this.queryRows.map((row) =>
      this.makeTagRow(row.id, row.fields),
    );
  }

  watchQuery(
    _collection: string,
    _options: unknown,
    callbacks: DbQueryWatchCallbacks<TagRowHandle>,
  ): DbQueryWatchHandle {
    this.watchCallbacks = callbacks as unknown as DbQueryWatchCallbacks<MockRow>;
    callbacks.onChange(
      this.queryRows.map((row) => this.makeTagRow(row.id, row.fields)),
    );
    return {
      disconnect: () => { this.disconnectCalls += 1; },
      refresh: async () => {
        this.refreshCalls += 1;
        callbacks.onChange(
          this.queryRows.map((row) => this.makeTagRow(row.id, row.fields)),
        );
      },
    };
  }

  async getExistingInviteToken(_row: DbRowRef): Promise<InviteToken | null> {
    return null;
  }

  async createInviteToken(row: DbRowRef): Promise<InviteToken> {
    return { token: "invite_1", roomId: row.id, invitedBy: row.owner, createdAt: 1 };
  }

  createInviteLink(row: Pick<DbRowRef, "workerUrl">, inviteToken: string): string {
    return `https://woof.example/?worker=${encodeURIComponent(row.workerUrl)}&token=${inviteToken}`;
  }

  async listMembers(_row: DbRowRef): Promise<string[]> {
    return this.memberList;
  }

  // RowHandleBackend implementation
  connectCrdt(_row: DbRowRef, callbacks: CrdtConnectCallbacks): CrdtConnection {
    this.crdtCallbacks = callbacks;
    return {
      disconnect() {},
      flush: async () => {
        const update = callbacks.produceLocalUpdate();
        void update;
      },
    };
  }

  async addParent(_child: DbRowRef, _parent: DbRowRef): Promise<void> {}
  async removeParent(_child: DbRowRef, _parent: DbRowRef): Promise<void> {}
  async listParents(_child: DbRowRef): Promise<DbRowRef[]> { return []; }
  async addMember(_row: DbRowRef, _username: string, _role: MemberRole): Promise<void> {}
  async removeMember(_row: DbRowRef, _username: string): Promise<void> {}
  async listDirectMembers(_row: DbRowRef): Promise<Array<{ username: string; role: MemberRole }>> { return []; }
  async listEffectiveMembers(_row: DbRowRef): Promise<DbMemberInfo[]> { return []; }
  async refreshFields(_row: DbRowRef): Promise<Record<string, import("puter-federation-sdk").JsonValue>> { return {}; }
}

describe("WoofService", () => {
  it("creates row on first-run adopt flow", async () => {
    const db = new MockDb();
    const kv = new MockKv();
    const service = new WoofService(db as unknown as WoofDb, kv);

    const profile = await service.enterChat({ dogName: "Rex" });

    expect(profile.row.id).toBe("row_created");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBe(
      "https://workers.puter.site/alex/rooms/row_created",
    );
  });

  it("joins row from invite input", async () => {
    const db = new MockDb();
    const kv = new MockKv();
    const service = new WoofService(db as unknown as WoofDb, kv);

    const profile = await service.joinFromInvite(
      "https://woof.example/?worker=https%3A%2F%2Fworkers.puter.site%2Falex%2Frooms%2Frow_joined&token=invite_1",
    );

    expect(profile.row.id).toBe("row_joined");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBe(
      "https://workers.puter.site/alex/rooms/row_joined",
    );
  });

  it("restores profile by worker URL with canonical field fetch", async () => {
    const db = new MockDb();
    const kv = new MockKv();
    const service = new WoofService(db as unknown as WoofDb, kv);

    await kv.set("woof:myDog", "https://workers.puter.site/alex/rooms/row_created");
    const restored = await service.restoreProfile();

    expect(String(restored?.row.fields.name)).toBe("Rex Canonical");
  });

  it("creates tags as DB child rows under the dog row", async () => {
    const db = new MockDb();
    const service = new WoofService(db as unknown as WoofDb, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });

    await service.createTag(profile, "friendly");

    const tagCall = db.putCalls.find((c) => c.collection === "tags");
    expect(tagCall).toBeDefined();
    expect(tagCall!.fields.label).toBe("friendly");
    expect(tagCall!.options?.in).toMatchObject({
      id: profile.row.id,
      collection: "dogs",
      owner: profile.row.owner,
      workerUrl: profile.row.workerUrl,
    });
  });

  it("loads tags from DB rows", async () => {
    const db = new MockDb();
    db.queryRows = [
      { id: "tag_1", fields: { label: "playful", createdBy: "alex", createdAt: 100 } },
      { id: "tag_2", fields: { label: "" } },
    ];

    const service = new WoofService(db as unknown as WoofDb, new MockKv(), new Y.Doc());
    const profile = await service.enterChat({ dogName: "Rex" });
    const tags = await service.listTags(profile);

    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ id: "tag_1", label: "playful", createdBy: "alex", createdAt: 100 });
  });

  it("watches tags and maps DB rows", async () => {
    const db = new MockDb();
    db.queryRows = [
      { id: "tag_1", fields: { label: "playful", createdBy: "alex", createdAt: 100 } },
      { id: "tag_2", fields: { label: " " } },
    ];

    const service = new WoofService(db as unknown as WoofDb, new MockKv(), new Y.Doc());
    const profile = await service.enterChat({ dogName: "Rex" });
    const updates: Array<Array<{ id: string; label: string }>> = [];

    service.watchTags(profile, {
      onChange: (tags) => {
        updates.push(tags.map((tag) => ({ id: tag.id, label: tag.label })));
      },
    });

    expect(updates).toEqual([[{ id: "tag_1", label: "playful" }]]);
  });

  it("supports refreshing and disconnecting tag watches after tag creation", async () => {
    const db = new MockDb();
    db.queryRows = [
      { id: "tag_1", fields: { label: "friendly", createdBy: "alex", createdAt: 100 } },
    ];

    const service = new WoofService(db as unknown as WoofDb, new MockKv(), new Y.Doc());
    const profile = await service.enterChat({ dogName: "Rex" });
    const watcher = service.watchTags(profile, { onChange() {} });

    await service.createTag(profile, "friendly");
    await watcher.refresh();
    watcher.disconnect();

    expect(db.putCalls.some((c) => c.collection === "tags")).toBe(true);
    expect(db.refreshCalls).toBe(1);
    expect(db.disconnectCalls).toBe(1);
  });

  it("refreshes saved profile with canonical row fields", async () => {
    const db = new MockDb();
    const kv = new MockKv();
    const service = new WoofService(db as unknown as WoofDb, kv);

    const profile = await service.joinFromInvite(
      "https://woof.example/?worker=https%3A%2F%2Fworkers.puter.site%2Falex%2Frooms%2Frow_joined&token=invite_1",
    );
    const refreshed = await service.refreshProfileCanonical(profile);

    expect(String(refreshed.row.fields.name)).toBe("Joined Canonical");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBe(
      "https://workers.puter.site/alex/rooms/row_joined",
    );
  });

  it("clears profile when canonical refresh fails", async () => {
    const db = new MockDb();
    const kv = new MockKv();
    const service = new WoofService(db as unknown as WoofDb, kv);

    const profile = await service.enterChat({ dogName: "Rex" });
    db.failGetRowByUrl = true;

    await expect(service.refreshProfileCanonical(profile)).rejects.toThrow("room lookup failed");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBeNull();
  });

  it("clears persisted worker URL when restore fails", async () => {
    const db = new MockDb();
    const kv = new MockKv();
    const service = new WoofService(db as unknown as WoofDb, kv);

    await kv.set("woof:myDog", "https://workers.puter.site/alex/rooms/row_created");
    db.failGetRowByUrl = true;

    await expect(service.restoreProfile()).rejects.toThrow("room lookup failed");
    await expect(loadStoredWorkerUrl(kv)).resolves.toBeNull();
  });

  it("sends user and dog messages in one turn", async () => {
    const db = new MockDb();
    const doc = new Y.Doc();
    const service = new WoofService(db as unknown as WoofDb, new MockKv(), doc);
    let chatInput: ChatMessage[] | undefined;

    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat(input: ChatMessage[]) {
        chatInput = input;
        return { message: { content: "woof!" } };
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

  it("uses row field name for dog persona", async () => {
    const db = new MockDb();
    const service = new WoofService(db as unknown as WoofDb, new MockKv());
    let chatInput: ChatMessage[] | undefined;

    const profile = await service.joinFromInvite(
      "https://woof.example/?worker=https%3A%2F%2Fworkers.puter.site%2Falex%2Frooms%2Frow_joined&token=invite_1",
    );
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat(input: ChatMessage[]) {
        chatInput = input;
        return { message: { content: "woof!" } };
      },
    });

    expect(chatInput?.[0]).toEqual({
      role: "system",
      content:
        "You are Joined, a friendly dog in a shared room with separate 1:1 threads. You can reply to multiple users, but you must always reply to the trigger user. Return STRICT JSON only: {\"triggerUserReply\":\"message\",\"otherReplies\":[{\"toUser\":\"username\",\"content\":\"message\"}]} Keep content short and playful.",
    });
  });

  it("formats history as chronological user and assistant messages", async () => {
    const db = new MockDb();
    const service = new WoofService(db as unknown as WoofDb, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);
    let secondTurnChatInput: ChatMessage[] | undefined;

    await service.sendTurn(profile, "first", {
      async chat() {
        return { message: { content: JSON.stringify({ triggerUserReply: "first bark" }) } };
      },
    });

    await service.sendTurn(profile, "second", {
      async chat(input: ChatMessage[]) {
        secondTurnChatInput = input;
        return { message: { content: "second bark" } };
      },
    });

    expect(secondTurnChatInput?.slice(2)).toEqual([
      { role: "user", content: "[alex \u2192 Rex] first" },
      { role: "assistant", content: "[Rex \u2192 alex] first bark" },
      { role: "user", content: "[alex \u2192 Rex] second" },
    ]);
  });

  it("falls back to canned dog reply when AI call fails", async () => {
    const db = new MockDb();
    const service = new WoofService(db as unknown as WoofDb, new MockKv());

    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat() { throw { message: "messages required" }; },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ userType: "user", content: "hello" });
    expect(entries[1]).toMatchObject({ userType: "dog", content: "Rex barks happily.", threadUser: "alex" });
  });

  it("can send additional dog replies to other users", async () => {
    const db = new MockDb();
    const service = new WoofService(db as unknown as WoofDb, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat() {
        return {
          message: {
            content: JSON.stringify({
              triggerUserReply: "[Rex \u2192 alex] woof for alex",
              otherReplies: [{ toUser: "friend", content: "[Rex \u2192 friend] woof for friend" }],
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
    const db = new MockDb();
    const service = new WoofService(db as unknown as WoofDb, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat() {
        return { message: { content: "[Rex \u2192 alex] plain woof" } };
      },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "plain woof", threadUser: "alex" });
  });

  it("forces a reply to actor when AI omits it", async () => {
    const db = new MockDb();
    const service = new WoofService(db as unknown as WoofDb, new MockKv());
    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.sendTurn(profile, "hello", {
      async chat() {
        return {
          message: {
            content: JSON.stringify({ otherReplies: [{ toUser: "friend", content: "hello friend" }] }),
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
    const db = new MockDb();
    const kv = new MockKv();
    const service = new WoofService(db as unknown as WoofDb, kv);

    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

    await service.relinquish();

    await expect(loadStoredWorkerUrl(kv)).resolves.toBeNull();
  });

  it("applies remote CRDT updates via applyRemoteUpdate callback", async () => {
    const db = new MockDb();
    const doc = new Y.Doc();
    const service = new WoofService(db as unknown as WoofDb, new MockKv(), doc);

    const profile = await service.enterChat({ dogName: "Rex" });
    service.connectToRoom(profile);

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
      roomId: "row_created",
      body: encodedBody,
      createdAt: 100,
      signedBy: "friend",
      sequence: 1,
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ content: "hello from remote", signedBy: "friend" });
  });
});
