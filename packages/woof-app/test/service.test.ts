import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  RowHandle,
  CrdtConnectCallbacks,
  CrdtConnection,
} from "@putbase/core";
import type {
  DbMemberInfo,
  DbRowLocator,
  DbRowRef,
  MemberRole,
  RowHandleBackend,
} from "@putbase/core";
import type { ChatMessage } from "@heyputer/puter.js";

import type {
  DogFields,
  DogRowHandle,
  TagFields,
  TagRowHandle,
  WoofSchema,
} from "../src/schema";
import { WoofService, type WoofDbPort } from "../src/service";

class MockDb implements WoofDbPort {
  public failOpenTarget = false;
  public readonly memberList = ["alex", "friend"];
  public crdtCallbacks: CrdtConnectCallbacks | null = null;

  public putCalls: Array<{
    collection: string;
    fields: Record<string, unknown>;
    options?: { in?: ReturnType<DogRowHandle["toRef"]> };
  }> = [];

  private readonly rowFields = new Map<string, Record<string, unknown>>();

  private readonly backend: RowHandleBackend<WoofSchema> = {
    addParent: async () => undefined,
    removeParent: async () => undefined,
    listParents: async <TParentCollection extends string>() => [] as Array<DbRowRef<TParentCollection>>,
    addMember: async () => undefined,
    removeMember: async () => undefined,
    listDirectMembers: async () => this.memberList.map((username) => ({
      username,
      role: this.roleFor(username),
    })),
    listEffectiveMembers: async () => this.memberList.map((username) => ({
      username,
      role: this.roleFor(username),
      via: "direct",
    })) as Array<DbMemberInfo<WoofSchema>>,
    refreshFields: async (row: DbRowLocator) => this.readFields(row.id),
    connectCrdt: (_row: DbRowLocator, callbacks: CrdtConnectCallbacks): CrdtConnection => {
      this.crdtCallbacks = callbacks;
      return {
        disconnect: () => undefined,
        flush: async () => {
          const update = callbacks.produceLocalUpdate();
          void update;
        },
      };
    },
    listMembers: async () => this.memberList,
  };

  private roleFor(username: string): MemberRole {
    return username === "alex" ? "admin" : "reader";
  }

  private readFields(id: string): Record<string, unknown> {
    return this.rowFields.get(id) ?? {};
  }

  private makeDogRow(id: string, fields: Record<string, unknown>): DogRowHandle {
    const target = `https://workers.puter.site/alex/rows/${id}`;
    const rowRef: ReturnType<DogRowHandle["toRef"]> = {
      id,
      collection: "dogs",
      owner: "alex",
      target,
    };
    const rowFields: DogFields = {
      name: typeof fields.name === "string" ? fields.name : "",
    };
    this.rowFields.set(id, rowFields);
    return new RowHandle(this.backend, rowRef, rowFields);
  }

  private makeTagRow(id: string, fields: Record<string, unknown>): TagRowHandle {
    const rowRef: ReturnType<TagRowHandle["toRef"]> = {
      id,
      collection: "tags",
      owner: "alex",
      target: `https://workers.puter.site/alex/rows/${id}`,
    };
    const rowFields: TagFields = {
      label: typeof fields.label === "string" ? fields.label : "",
      createdBy: typeof fields.createdBy === "string" ? fields.createdBy : "",
      createdAt: typeof fields.createdAt === "number" ? fields.createdAt : 0,
    };
    this.rowFields.set(id, rowFields);
    return new RowHandle(this.backend, rowRef, rowFields);
  }

  async whoAmI(): Promise<{ username: string }> {
    return { username: "alex" };
  }

  async put(collection: "dogs", fields: DogRowHandle["fields"]): Promise<DogRowHandle>;
  async put(
    collection: "tags",
    fields: TagRowHandle["fields"],
    options: { in: ReturnType<DogRowHandle["toRef"]> },
  ): Promise<TagRowHandle>;
  async put(
    collection: "dogs" | "tags",
    fields: Record<string, unknown>,
    options?: { in?: ReturnType<DogRowHandle["toRef"]> },
  ): Promise<DogRowHandle | TagRowHandle> {
    this.putCalls.push({ collection, fields, options });
    const id = collection === "dogs" ? "row_created" : `tag_${this.putCalls.length}`;
    return collection === "dogs"
      ? this.makeDogRow(id, fields)
      : this.makeTagRow(id, fields);
  }

  async openTarget(target: string): Promise<DogRowHandle> {
    if (this.failOpenTarget) {
      throw new Error("row lookup failed");
    }
    const joined = target.includes("row_joined");
    const id = joined ? "row_joined" : "row_created";
    const name = joined ? "Joined Canonical" : "Rex Canonical";
    return this.makeDogRow(id, { name });
  }

  async openInvite(_input: string): Promise<DogRowHandle> {
    return this.makeDogRow("row_joined", { name: "Joined" });
  }

  async listMembers(_row: DogRowHandle): Promise<string[]> {
    return this.memberList;
  }
}

describe("WoofService", () => {
  it("creates row on first-run adopt flow", async () => {
    const db = new MockDb();
    const service = new WoofService(db);

    const row = await service.enterChat({ dogName: "Rex" });

    expect(row.id).toBe("row_created");
    expect(row.target).toBe("https://workers.puter.site/alex/rows/row_created");
  });

  it("narrows app rows to dogs rows", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await db.openInvite(
      "https://woof.example/?worker=https%3A%2F%2Fworkers.puter.site%2Falex%2Frows%2Frow_joined&token=invite_1",
    );

    expect(service.expectDogRow(row).id).toBe("row_joined");
    expect(String(service.expectDogRow(row).fields.name)).toBe("Joined");
  });

  it("creates tags as DB child rows under the dog row", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });

    await service.createTag(row, "friendly");

    const tagCall = db.putCalls.find((c) => c.collection === "tags");
    expect(tagCall).toBeDefined();
    expect(tagCall!.fields.label).toBe("friendly");
    expect(tagCall!.options?.in).toMatchObject({
      id: row.id,
      collection: "dogs",
      owner: row.owner,
      target: row.target,
    });
  });

  it("sends user and dog messages in one turn", async () => {
    const db = new MockDb();
    const doc = new Y.Doc();
    const service = new WoofService(db, doc);
    let chatInput: ChatMessage[] | undefined;

    const row = await service.enterChat({ dogName: "Rex" });
    service.connectToRow(row);

    await service.sendTurn(row, "hello", {
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
      content: "[alex → Rex] hello",
    });
  });

  it("uses row field name for dog persona", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    let chatInput: ChatMessage[] | undefined;

    const row = await db.openInvite(
      "https://woof.example/?worker=https%3A%2F%2Fworkers.puter.site%2Falex%2Frows%2Frow_joined&token=invite_1",
    );
    service.connectToRow(row);

    await service.sendTurn(row, "hello", {
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
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    service.connectToRow(row);
    let secondTurnChatInput: ChatMessage[] | undefined;

    await service.sendTurn(row, "first", {
      async chat() {
        return { message: { content: JSON.stringify({ triggerUserReply: "first bark" }) } };
      },
    });

    await service.sendTurn(row, "second", {
      async chat(input: ChatMessage[]) {
        secondTurnChatInput = input;
        return { message: { content: "second bark" } };
      },
    });

    expect(secondTurnChatInput?.slice(2)).toEqual([
      { role: "user", content: "[alex → Rex] first" },
      { role: "assistant", content: "[Rex → alex] first bark" },
      { role: "user", content: "[alex → Rex] second" },
    ]);
  });

  it("falls back to canned dog reply when AI call fails", async () => {
    const db = new MockDb();
    const service = new WoofService(db);

    const row = await service.enterChat({ dogName: "Rex" });
    service.connectToRow(row);

    await service.sendTurn(row, "hello", {
      async chat() { throw { message: "messages required" }; },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ userType: "user", content: "hello" });
    expect(entries[1]).toMatchObject({ userType: "dog", content: "Rex barks happily.", threadUser: "alex" });
  });

  it("can send additional dog replies to other users", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    service.connectToRow(row);

    await service.sendTurn(row, "hello", {
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
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "woof for alex", threadUser: "alex" });
    expect(entries[2]).toMatchObject({ userType: "dog", content: "woof for friend", threadUser: "friend" });
  });

  it("strips address prefix from plain-text AI replies", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    service.connectToRow(row);

    await service.sendTurn(row, "hello", {
      async chat() {
        return { message: { content: "[Rex → alex] plain woof" } };
      },
    });

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ userType: "dog", content: "plain woof", threadUser: "alex" });
  });

  it("forces a reply to actor when AI omits it", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    service.connectToRow(row);

    await service.sendTurn(row, "hello", {
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

  it("relinquish disconnects CRDT state", async () => {
    const db = new MockDb();
    const service = new WoofService(db);
    const row = await service.enterChat({ dogName: "Rex" });
    service.connectToRow(row);

    await service.relinquish();

    expect(service.chatArray.toArray()).toEqual([]);
  });

  it("applies remote CRDT updates via applyRemoteUpdate callback", async () => {
    const db = new MockDb();
    const doc = new Y.Doc();
    const service = new WoofService(db, doc);

    const row = await service.enterChat({ dogName: "Rex" });
    service.connectToRow(row);

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

    const entries = service.chatArray.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ content: "hello from remote", signedBy: "friend" });
  });
});
