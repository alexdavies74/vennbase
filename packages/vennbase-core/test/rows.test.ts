import { afterEach, describe, expect, it, vi } from "vitest";

import { createMutationReceipt } from "../src/mutation-receipt";
import { OptimisticStore } from "../src/optimistic-store";
import { loadSavedRow, saveRow } from "../src/saved-rows";
import { VennbaseError } from "../src/errors";
import { Vennbase } from "../src/vennbase";
import { Query } from "../src/query";
import { CURRENT_USER, collection, defineSchema, field } from "../src/schema";
import type { BackendClient } from "../src/types";
import { InMemoryKv } from "../src/worker/in-memory-kv";
import { RowWorker } from "../src/worker/core";

function asUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

class TestWorkerNetwork {
  private readonly workers = new Map<string, RowWorker>();

  register(baseUrl: string, worker: RowWorker): void {
    this.workers.set(baseUrl.replace(/\/+$/g, ""), worker);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = asUrl(input);
    const baseUrl = this.resolveBaseUrl(url);
    if (!baseUrl) {
      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: `No worker for ${url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const worker = this.workers.get(baseUrl);
    if (!worker) {
      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: `Worker missing for ${url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const request = new Request(url, init);
    return worker.handle(request, {
      workersExec: (nextUrl, nextInit) => this.fetch(nextUrl, nextInit),
    });
  };

  private resolveBaseUrl(requestUrl: string): string | null {
    let best: string | null = null;
    for (const candidate of this.workers.keys()) {
      if (!requestUrl.startsWith(candidate)) continue;
      if (!best || candidate.length > best.length) best = candidate;
    }
    return best;
  }
}

const schema = defineSchema({
  projects: collection({
    fields: {
      name: field.string(),
    },
  }),
  tasks: collection({
    in: ["projects"],
    fields: {
      title: field.string(),
      status: field.string().indexKey().default("todo"),
    },
  }),
  gameRecords: collection({
    in: ["user"],
    fields: {
      gameRef: field.ref("projects").indexKey(),
      role: field.string().indexKey(),
    },
  }),
});

const INTERNAL_USER_SCOPE_ROW_KEY = "__vennbase_user_scope_v1__";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function settle<T>(receipt: { committed: Promise<T> }): Promise<T> {
  return receipt.committed;
}

function buildWatchRow(id: string, title: string) {
  return {
    id,
    collection: "tasks",
    owner: "alice",
    ref: {
      id,
      collection: "tasks",
      baseUrl: "https://worker.example",
    },
    fields: { title, status: "todo" },
  };
}

function buildDb(args: {
  username: string;
  network: TestWorkerNetwork;
  backend?: BackendClient;
}): Vennbase<typeof schema> {
  const workerBase = `https://${args.username}-federation.example`;

  args.network.register(
    workerBase,
    new RowWorker(
      { owner: args.username, workerUrl: workerBase },
      { kv: new InMemoryKv() },
    ),
  );

  return new Vennbase({
    schema,
    backend: args.backend,
    identityProvider: async () => ({ username: args.username }),
    fetchFn: args.network.fetch as typeof fetch,
    appBaseUrl: `https://app.${args.username}.example`,
    deployWorker: async () => workerBase,
  });
}

async function buildReadyDb(args: {
  username: string;
  network: TestWorkerNetwork;
  backend?: BackendClient;
}): Promise<Vennbase<typeof schema>> {
  const db = buildDb(args);
  await db.getSession();
  return db;
}

function buildQueryForWatchTests(): Query<typeof schema> {
  const optimisticStore = new OptimisticStore();
  return new Query(
    { row: vi.fn() } as never,
    { getRow: vi.fn() } as never,
    optimisticStore,
    schema,
  );
}

describe("Vennbase rows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts, updates, and queries indexed rows", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const project = await settle(db.create("projects", { name: "Website" }));
    const task = await settle(db.create("tasks", { title: "Ship v2" }, { in: project.ref }));

    await settle(db.update("tasks", task.ref, { status: "done" }));

    const done = await db.query("tasks", {
      in: project.ref,
      where: { status: "done" },
    });

    expect(done).toHaveLength(1);
    expect(done[0].id).toBe(task.id);
    expect(done[0].fields.title).toBe("Ship v2");
    expect(done[0].fields.status).toBe("done");
  });

  it("removes stale index entries when an indexed field changes", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const project = await settle(db.create("projects", { name: "Website" }));
    const task = await settle(db.create("tasks", { title: "Ship v2" }, { in: project.ref }));

    await settle(db.update("tasks", task.ref, { status: "done" }));

    const todo = await db.query("tasks", {
      in: project.ref,
      where: { status: "todo" },
    });
    const done = await db.query("tasks", {
      in: project.ref,
      where: { status: "done" },
    });

    expect(todo).toHaveLength(0);
    expect(done).toHaveLength(1);
    expect(done[0].id).toBe(task.id);
  });

  it("accepts row handles for row-scoped API inputs", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const project = await settle(db.create("projects", { name: "Website" }));
    const task = await settle(db.create("tasks", { title: "Ship v2" }, { in: project }));
    await settle(db.update("tasks", task, { status: "done" }));

    const tasks = await db.query("tasks", {
      in: project,
      where: { status: "done" },
    });
    const members = await db.listMembers(project);
    const shareToken = db.createShareToken(project, "all-editor");
    await shareToken.committed;
    const shareLink = db.createShareLink(project, shareToken.value);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].fields.title).toBe("Ship v2");
    expect(tasks[0].fields.status).toBe("done");
    expect(members).toContain("alice");
    expect(shareLink).toContain("db=");
  });

  it("puts and queries user-scoped rows with CURRENT_USER", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });
    const project = await settle(db.create("projects", { name: "Game 1" }));

    const record = await settle(db.create("gameRecords", {
      gameRef: project.ref,
      role: "owner",
    }, {
      in: CURRENT_USER,
    }));

    const records = await db.query("gameRecords", {
      in: CURRENT_USER,
      where: { gameRef: project.ref },
    });
    const parents = await record.in.list();

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(record.id);
    expect(parents).toEqual([
      expect.objectContaining({
        collection: "user",
      }),
    ]);
  });

  it("queries empty user-scoped indexed collections without registered child schema", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });
    const project = await settle(db.create("projects", { name: "Game 1" }));

    const records = await db.query("gameRecords", {
      in: CURRENT_USER,
      where: { gameRef: project.ref },
      orderBy: "role",
      order: "asc",
      limit: 5,
    });

    expect(records).toEqual([]);
  });

  it("matches ref where clauses even when row-ref property order differs", async () => {
    const transport = {
      row: vi.fn().mockReturnValue({
        request: vi.fn().mockResolvedValue({
          rows: [{
            rowId: "record_1",
            owner: "alice",
            baseUrl: "https://worker.example",
            collection: "gameRecords",
            fields: {
              gameRef: {
                baseUrl: "https://worker.example",
                id: "project_1",
                collection: "projects",
              },
              role: "owner",
            },
          }],
        }),
      }),
    };
    const getRow = vi.fn(async (row: { id: string; collection: string; baseUrl: string }) => ({
      id: row.id,
      collection: "gameRecords",
      owner: "alice",
      ref: row,
      fields: {
        gameRef: {
          id: "project_1",
          collection: "projects",
          baseUrl: "https://worker.example",
        },
        role: "owner",
      },
    }));
    const optimisticStore = new OptimisticStore();
    const query = new Query(
      transport as never,
      { getRow } as never,
      optimisticStore,
      schema,
    );

    const records = await query.query("gameRecords", {
      in: {
        id: "user_scope",
        collection: "user",
        baseUrl: "https://worker.example",
      },
      where: {
        gameRef: {
          id: "project_1",
          collection: "projects",
          baseUrl: "https://worker.example",
        },
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("record_1");
  });

  it("reuses and recreates remembered user scope rows as needed", async () => {
    const network = new TestWorkerNetwork();
    const backend = { workers: {}, kv: new InMemoryKv() } as BackendClient;
    const db = await buildReadyDb({ username: "alice", network, backend });
    const firstProject = await settle(db.create("projects", { name: "Game 1" }));

    await settle(db.create("gameRecords", {
      gameRef: firstProject.ref,
      role: "owner",
    }, {
      in: CURRENT_USER,
    }));

    const rememberedBefore = await loadSavedRow(backend, INTERNAL_USER_SCOPE_ROW_KEY);
    expect(rememberedBefore).toBeTruthy();

    await db.query("gameRecords", { in: CURRENT_USER, where: { role: "owner" } });
    const rememberedAfterReuse = await loadSavedRow(backend, INTERNAL_USER_SCOPE_ROW_KEY);
    expect(rememberedAfterReuse).toEqual(rememberedBefore);

    await saveRow(backend, INTERNAL_USER_SCOPE_ROW_KEY, {
      id: "row_missing",
      collection: "user",
      baseUrl: "https://alice-federation.example",
    });
    const secondProject = await settle(db.create("projects", { name: "Game 2" }));

    await settle(db.create("gameRecords", {
      gameRef: secondProject.ref,
      role: "viewer",
    }, {
      in: CURRENT_USER,
    }));

    const recreated = await db.query("gameRecords", { in: CURRENT_USER, where: { role: "viewer" } });
    const rememberedAfterRecreate = await loadSavedRow(backend, INTERNAL_USER_SCOPE_ROW_KEY);

    expect(recreated).toHaveLength(1);
    expect(rememberedAfterRecreate).toBeTruthy();
    expect(rememberedAfterRecreate?.baseUrl).toBeTruthy();
  });

  it("reuses row handles for the life of a row and updates fields in place", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const project = await settle(db.create("projects", { name: "Website" }));
    const task = await settle(db.create("tasks", { title: "Ship v2" }, { in: project.ref }));

    const firstGet = await db.getRow(task.ref);
    const secondGet = await db.getRow(task.ref);
    const firstReopen = await db.getRow(task.ref);
    const secondReopen = await db.getRow(task.ref);

    expect(secondGet).toBe(firstGet);
    expect(firstReopen).toBe(firstGet);
    expect(secondReopen).toBe(firstGet);

    await settle(db.update("tasks", task.ref, { status: "done" }));

    const afterChange = await db.getRow(task.ref);
    expect(afterChange).toBe(firstGet);
    expect(afterChange.fields.status).toBe("done");
    expect(firstGet.fields.status).toBe("done");
  });

  it("supports cross-owner linking and scoped queries", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const aliceProject = await settle(aliceDb.create("projects", { name: "Roadmap" }));
    await aliceProject.members.add("bob", "content-submitter").committed;

    const bobProject = await settle(bobDb.create("projects", { name: "Bob scope" }));
    const bobTask = await settle(bobDb.create("tasks", { title: "Review" }, { in: bobProject.ref }));
    await bobTask.in.add(aliceProject.ref).committed;

    const tasks = await aliceDb.query("tasks", { in: aliceProject.ref });

    expect(tasks.some((task) => task.id === bobTask.id)).toBe(true);
  });

  it("lists canonical parent refs that can be reused in schema-aware queries", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const aliceProject = await settle(aliceDb.create("projects", { name: "Roadmap" }));
    await aliceProject.members.add("bob", "content-submitter").committed;

    const bobProject = await settle(bobDb.create("projects", { name: "Bob scope" }));
    const bobTask = await settle(bobDb.create("tasks", { title: "Review" }, { in: bobProject.ref }));
    await bobTask.in.add(aliceProject.ref).committed;

    const parents = await bobTask.in.list();
    expect(parents).toHaveLength(2);
    expect(parents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: aliceProject.id,
        collection: "projects",
        baseUrl: aliceProject.ref.baseUrl,
      }),
      expect.objectContaining({
        id: bobProject.id,
        collection: "projects",
        baseUrl: bobProject.ref.baseUrl,
      }),
    ]));

    const aliceParent = parents.find((parent) => parent.id === aliceProject.id);
    expect(aliceParent).toBeTruthy();

    const tasks = await aliceDb.query("tasks", { in: aliceParent!, limit: 20 });
    expect(tasks.some((task) => task.id === bobTask.id)).toBe(true);
  });

  it("returns effective-member ancestry via canonical parent refs", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const aliceProject = await settle(aliceDb.create("projects", { name: "Roadmap" }));
    await aliceProject.members.add("bob", "content-submitter").committed;

    const bobProject = await settle(bobDb.create("projects", { name: "Bob scope" }));
    const bobTask = await settle(bobDb.create("tasks", { title: "Review" }, { in: bobProject.ref }));
    await bobTask.in.add(aliceProject.ref).committed;

    const aliceTask = await aliceDb.getRow(bobTask.ref);

    const members = await aliceTask.members.effective();
    const aliceMember = members.find((member) => member.username === "alice");

    expect(aliceMember).toMatchObject({
      username: "alice",
      roles: ["all-editor"],
      via: {
        id: aliceProject.id,
        collection: "projects",
        baseUrl: aliceProject.ref.baseUrl,
      },
    });
  });

  it("lets invite-joined writers update shared child rows when they can maintain parent indexes", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const project = await settle(aliceDb.create("projects", { name: "Roadmap" }));
    await project.members.add("bob", "all-editor").committed;
    const task = await settle(aliceDb.create("tasks", { title: "Review" }, { in: project.ref }));
    const shareToken = aliceDb.createShareToken(task.ref, "all-editor");
    await shareToken.committed;
    const shareLink = aliceDb.createShareLink(task.ref, shareToken.value);

    const joined = await bobDb.acceptInvite(shareLink);
    expect(joined.collection).toBe("tasks");
    if (joined.collection !== "tasks") {
      throw new Error(`Expected tasks row, got ${joined.collection}`);
    }

    const updated = bobDb.update("tasks", joined.ref, { status: "done" });
    await updated.committed;

    const refreshed = await aliceDb.getRow(task.ref);
    expect(refreshed.fields.status).toBe("done");

    const rows = await aliceDb.query("tasks", {
      in: project.ref,
      where: { status: "done" },
    });
    expect(rows.some((row) => row.id === task.id)).toBe(true);

    const directMembers = await aliceDb.listDirectMembers(task.ref);
    expect(directMembers).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: "bob", role: "all-editor" }),
    ]));
  });

  it("supports write-only submitter invites for blind inboxes", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const project = await settle(aliceDb.create("projects", { name: "Inbox" }));
    const submissionLink = aliceDb.createShareLink(project.ref, "index-submitter");
    const submissionUrl = await submissionLink.committed;

    await expect(bobDb.acceptInvite(submissionUrl)).rejects.toThrow("join-only access");

    const joined = await bobDb.joinInvite(submissionUrl);
    expect(joined).toEqual({
      ref: project.ref,
      role: "index-submitter",
    });

    const task = await settle(bobDb.create("tasks", { title: "Need review" }, { in: joined.ref }));

    const submitterRows = await bobDb.query("tasks", { in: joined.ref, select: "indexKeys" });
    expect(submitterRows).toEqual([
      expect.objectContaining({
        kind: "index-key-projection",
        id: task.id,
        collection: "tasks",
        fields: { status: "todo" },
      }),
    ]);
    expect(submitterRows[0]).not.toHaveProperty("owner");
    expect(submitterRows[0]).not.toHaveProperty("baseUrl");
    expect(submitterRows[0]).not.toHaveProperty("ref");

    const ownerRows = await aliceDb.query("tasks", { in: project.ref });
    expect(ownerRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: task.id }),
    ]));

    const submitterFullQuery = bobDb.query("tasks", { in: joined.ref });
    await expect(submitterFullQuery).rejects.toBeInstanceOf(VennbaseError);
    await expect(submitterFullQuery).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });

    const reopened = await bobDb.getRow(task.ref);
    expect(reopened.fields.status).toBe("todo");

    await bobDb.update("tasks", reopened.ref, { status: "done" }).committed;
    const updated = await bobDb.getRow(task.ref);
    expect(updated.fields.status).toBe("done");

    await updated.in.remove(joined.ref).committed;
    const parentsAfterRemoval = await updated.in.list();
    expect(parentsAfterRemoval).not.toEqual(expect.arrayContaining([project.ref]));

    const memberRole = await bobDb.getRow(task.ref).then((row) => row.members.effective());
    expect(memberRole).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        username: "bob",
        via: project.ref,
      }),
    ]));
  });

  it("rejects viewer attempts to mint stronger invites", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const project = await settle(aliceDb.create("projects", { name: "Roadmap" }));
    await project.members.add("bob", "content-viewer").committed;

    const inviteWrite = bobDb.createShareLink(project.ref, "all-editor");
    await expect(inviteWrite.committed).rejects.toBeInstanceOf(VennbaseError);
    await expect(inviteWrite.committed).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("lets submitters mint submitter invites", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });
    const charlieDb = await buildReadyDb({ username: "charlie", network });

    const project = await settle(aliceDb.create("projects", { name: "Inbox" }));
    const submissionUrl = await aliceDb.createShareLink(project.ref, "index-submitter").committed;

    const joined = await bobDb.joinInvite(submissionUrl);
    expect(joined).toEqual({
      ref: project.ref,
      role: "index-submitter",
    });

    const forwardedSubmissionUrl = await bobDb.createShareLink(joined.ref, "index-submitter").committed;
    await expect(charlieDb.joinInvite(forwardedSubmissionUrl)).resolves.toEqual({
      ref: project.ref,
      role: "index-submitter",
    });
  });

  it("lets contributors mint viewer and submitter invites", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });
    const charlieDb = await buildReadyDb({ username: "charlie", network });
    const danaDb = await buildReadyDb({ username: "dana", network });

    const project = await settle(aliceDb.create("projects", { name: "Roadmap" }));
    await project.members.add("bob", "content-submitter").committed;

    const viewerUrl = await bobDb.createShareLink(project.ref, "content-viewer").committed;
    const submitterUrl = await bobDb.createShareLink(project.ref, "index-submitter").committed;

    const opened = await charlieDb.acceptInvite(viewerUrl);
    expect(opened.ref).toEqual(project.ref);
    expect(opened.collection).toBe("projects");

    await expect(danaDb.joinInvite(submitterUrl)).resolves.toEqual({
      ref: project.ref,
      role: "index-submitter",
    });
  });

  it("creates future-valid submitter links from optimistic row handles", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const projectWrite = aliceDb.create("projects", { name: "Inbox" });
    const project = projectWrite.value;
    const submissionLinkWrite = aliceDb.createShareLink(project, "index-submitter");
    const submissionUrl = submissionLinkWrite.value;

    await Promise.all([
      projectWrite.committed,
      submissionLinkWrite.committed,
    ]);

    await expect(bobDb.joinInvite(submissionUrl)).resolves.toEqual({
      ref: project.ref,
      role: "index-submitter",
    });
  });

  it("blocks viewers from linking child rows into shared parents", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const aliceProject = await settle(aliceDb.create("projects", { name: "Roadmap" }));
    await aliceProject.members.add("bob", "content-viewer").committed;

    const bobProject = await settle(bobDb.create("projects", { name: "Bob scope" }));
    const bobTask = await settle(bobDb.create("tasks", { title: "Review" }, { in: bobProject.ref }));

    const rejectedLink = bobTask.in.add(aliceProject.ref).committed;
    await expect(rejectedLink).rejects.toBeInstanceOf(VennbaseError);
    await expect(rejectedLink).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });

    const tasks = await aliceDb.query("tasks", { in: aliceProject.ref });
    expect(tasks.some((task) => task.id === bobTask.id)).toBe(false);
  });

  it("rejects unknown and non-scalar field payloads", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    expect(
      () => db.create("projects", { name: "Website", extra: "ignored" } as never),
    ).toThrow("Unknown field projects.extra");

    expect(
      () => db.create("projects", { name: { label: "Website" } } as never),
    ).toThrow("Field projects.name must be a string");

    const project = await settle(db.create("projects", { name: "Website" }));
    const task = await settle(db.create("tasks", { title: "Ship v2" }, { in: project.ref }));

    expect(
      () => db.update("tasks", task.ref, { status: ["done"] } as never),
    ).toThrow("Field tasks.status must be a string");
  });

  it("rejects query results when canonical row hydration fails", async () => {
    const transport = {
      row: vi.fn().mockReturnValue({
        request: vi.fn().mockResolvedValue({
          rows: [{
            rowId: "task_1",
            owner: "alice",
            baseUrl: "https://worker.example/",
            collection: "tasks",
            fields: { title: "Embedded snapshot", status: "todo" },
          }],
        }),
      }),
    };
    const getRow = vi.fn().mockRejectedValue(new Error("canonical fetch failed"));
    const optimisticStore = new OptimisticStore();
    const query = new Query(
      transport as never,
      { getRow } as never,
      optimisticStore,
      schema,
    );

    await expect(query.query("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        baseUrl: "https://worker.example",
      },
    })).rejects.toThrow("canonical fetch failed");

    expect(getRow).toHaveBeenCalledWith({
      id: "task_1",
      collection: "tasks",
      baseUrl: "https://worker.example",
    });
  });

  it("rejects non-index-key where fields locally before sending the query", async () => {
    const request = vi.fn();
    const transport = {
      row: vi.fn(() => ({
        request,
      })),
    };
    const optimisticStore = new OptimisticStore();
    const query = new Query(
      transport as never,
      { getRow: vi.fn() } as never,
      optimisticStore,
      schema,
    );

    await expect(query.query("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        baseUrl: "https://worker.example",
      },
      where: { title: "Ship v2" },
    } as never)).rejects.toThrow("where.title must be an index-key field");

    expect(transport.row).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects non-index-key orderBy locally before sending the query", async () => {
    const request = vi.fn();
    const transport = {
      row: vi.fn(() => ({
        request,
      })),
    };
    const optimisticStore = new OptimisticStore();
    const query = new Query(
      transport as never,
      { getRow: vi.fn() } as never,
      optimisticStore,
      schema,
    );

    await expect(query.query("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        baseUrl: "https://worker.example",
      },
      orderBy: "title",
    } as never)).rejects.toThrow("orderBy must be an index-key field");

    expect(transport.row).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects parentless collection queries locally", async () => {
    const request = vi.fn();
    const transport = {
      row: vi.fn(() => ({
        request,
      })),
    };
    const optimisticStore = new OptimisticStore();
    const query = new Query(
      transport as never,
      { getRow: vi.fn() } as never,
      optimisticStore,
      schema,
    );

    await expect(query.query("projects", {} as never)).rejects.toThrow(
      "Collection projects cannot be queried because queries always require in and this collection has no parent scope.",
    );

    expect(transport.row).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("globally sorts indexed multi-parent queries before applying the final limit", async () => {
    const multiParentSchema = defineSchema({
      shelves: collection({
        fields: {
          name: field.string(),
        },
      }),
      cards: collection({
        in: ["shelves"],
        fields: {
          title: field.string(),
          rank: field.number().indexKey(),
        },
      }),
    });

    const parentResponses = new Map([
      ["shelf_1", {
        rows: [
          {
            rowId: "card_2",
            owner: "alice",
            baseUrl: "https://worker.example",
            collection: "cards",
            fields: { rank: 2 },
          },
          {
            rowId: "card_3",
            owner: "alice",
            baseUrl: "https://worker.example",
            collection: "cards",
            fields: { rank: 3 },
          },
        ],
      }],
      ["shelf_2", {
        rows: [
          {
            rowId: "card_1",
            owner: "alice",
            baseUrl: "https://worker.example",
            collection: "cards",
            fields: { rank: 1 },
          },
          {
            rowId: "card_2",
            owner: "alice",
            baseUrl: "https://worker.example",
            collection: "cards",
            fields: { rank: 2 },
          },
        ],
      }],
    ]);

    const transport = {
      row: vi.fn((parent: { id: string }) => ({
        request: vi.fn().mockResolvedValue(parentResponses.get(parent.id)),
      })),
    };
    const getRow = vi.fn(async (row: { id: string; collection: string; baseUrl: string }) => ({
      id: row.id,
      collection: "cards",
      owner: "alice",
      ref: row,
      fields: {},
    }));
    const optimisticStore = new OptimisticStore();
    const query = new Query(
      transport as never,
      { getRow } as never,
      optimisticStore,
      multiParentSchema,
    );

    const rows = await query.query("cards", {
      in: [
        {
          id: "shelf_1",
          collection: "shelves",
          baseUrl: "https://worker.example",
        },
        {
          id: "shelf_2",
          collection: "shelves",
          baseUrl: "https://worker.example",
        },
      ],
      orderBy: "rank",
      order: "asc",
      limit: 2,
    });

    expect(rows.map((row) => row.id)).toEqual(["card_1", "card_2"]);
    expect(getRow.mock.calls.map(([row]) => row.id)).toEqual(["card_1", "card_2"]);
  });

  it("returns index-key projections for index-key queries and dedupes multi-parent results by id", async () => {
    const multiParentSchema = defineSchema({
      shelves: collection({
        fields: {
          name: field.string(),
        },
      }),
      cards: collection({
        in: ["shelves"],
        fields: {
          title: field.string(),
          rank: field.number().indexKey(),
        },
      }),
    });

    const parentResponses = new Map([
      ["shelf_1", {
        rows: [
          {
            rowId: "card_2",
            collection: "cards",
            fields: { rank: 2 },
          },
          {
            rowId: "card_3",
            collection: "cards",
            fields: { rank: 3 },
          },
        ],
      }],
      ["shelf_2", {
        rows: [
          {
            rowId: "card_1",
            collection: "cards",
            fields: { rank: 1 },
          },
          {
            rowId: "card_2",
            collection: "cards",
            fields: { rank: 2 },
          },
        ],
      }],
    ]);

    const transport = {
      row: vi.fn((parent: { id: string }) => ({
        request: vi.fn().mockResolvedValue(parentResponses.get(parent.id)),
      })),
    };
    const getRow = vi.fn();
    const optimisticStore = new OptimisticStore();
    const query = new Query(
      transport as never,
      { getRow } as never,
      optimisticStore,
      multiParentSchema,
    );

    const rows = await query.query("cards", {
      in: [
        {
          id: "shelf_1",
          collection: "shelves",
          baseUrl: "https://worker.example",
        },
        {
          id: "shelf_2",
          collection: "shelves",
          baseUrl: "https://worker.example",
        },
      ],
      select: "indexKeys",
      orderBy: "rank",
      order: "asc",
      limit: 2,
    });

    expect(rows).toEqual([
      {
        kind: "index-key-projection",
        id: "card_1",
        collection: "cards",
        fields: { rank: 1 },
      },
      {
        kind: "index-key-projection",
        id: "card_2",
        collection: "cards",
        fields: { rank: 2 },
      },
    ]);
    expect(rows[0]).not.toHaveProperty("ref");
    expect(getRow).not.toHaveBeenCalled();
  });

  it("skips remote querying when the parent exists only as a pending optimistic create", async () => {
    const transport = {
      row: vi.fn(() => ({
        request: vi.fn(),
      })),
    };
    const optimisticStore = new OptimisticStore();
    const parent = {
      id: "project_1",
      collection: "projects",
      baseUrl: "https://worker.example",
    } as const;
    optimisticStore.beginCreate({
      row: parent,
      owner: "alice",
      collection: "projects",
      fields: { name: "Website" },
      parents: [],
      receipt: createMutationReceipt(parent),
    });
    const getRow = vi.fn();
    const query = new Query(
      transport as never,
      { getRow } as never,
      optimisticStore,
      schema,
    );

    const rows = await query.query("tasks", { in: parent });

    expect(rows).toEqual([]);
    expect(transport.row).not.toHaveBeenCalled();
    expect(getRow).not.toHaveBeenCalled();
  });

  it("records remote query membership so later synchronous peeks can reuse cached rows", async () => {
    const parent = {
      id: "project_1",
      collection: "projects",
      baseUrl: "https://worker.example",
    } as const;
    const taskRef = {
      id: "task_1",
      collection: "tasks",
      baseUrl: "https://worker.example",
    } as const;
    const transport = {
      row: vi.fn(() => ({
        request: vi.fn().mockResolvedValue({
          rows: [{
            rowId: taskRef.id,
            owner: "alice",
            baseUrl: taskRef.baseUrl,
            collection: "tasks",
            fields: { status: "todo" },
          }],
        }),
      })),
    };
    const optimisticStore = new OptimisticStore();
    const getRow = vi.fn(async (row: typeof taskRef) => {
      optimisticStore.upsertBaseRow(row, "alice", "tasks", {
        title: "Ship v2",
        status: "todo",
      });
      return {
        id: row.id,
        collection: row.collection,
        owner: "alice",
        ref: row,
        fields: {
          title: "Ship v2",
          status: "todo",
        },
      };
    });
    const peekRow = vi.fn((row: typeof taskRef) => {
      const fields = optimisticStore.getLogicalFields(row);
      const owner = optimisticStore.getOwner(row);
      if (!fields || !owner) {
        return null;
      }
      return {
        id: row.id,
        collection: row.collection,
        owner,
        ref: row,
        fields,
      };
    });
    const query = new Query(
      transport as never,
      { getRow, peekRow } as never,
      optimisticStore,
      schema,
    );

    const initial = await query.query("tasks", { in: parent });
    expect(initial).toHaveLength(1);

    transport.row.mockClear();
    getRow.mockClear();
    optimisticStore.applyOverlay(taskRef, "tasks", { title: "Ship v3" });

    const rows = query.peekQuery("tasks", { in: parent });

    expect(rows).toHaveLength(1);
    expect(rows[0].fields.title).toBe("Ship v3");
    expect(transport.row).not.toHaveBeenCalled();
    expect(getRow).not.toHaveBeenCalled();
    expect(peekRow).toHaveBeenCalledWith(taskRef);
  });

  it("skips unresolved rows during synchronous peeks instead of fetching them", () => {
    const parent = {
      id: "project_1",
      collection: "projects",
      baseUrl: "https://worker.example",
    } as const;
    const taskRef = {
      id: "task_1",
      collection: "tasks",
      baseUrl: "https://worker.example",
    } as const;
    const transport = {
      row: vi.fn(() => ({
        request: vi.fn(),
      })),
    };
    const optimisticStore = new OptimisticStore();
    optimisticStore.recordParent(taskRef, parent);
    const getRow = vi.fn();
    const peekRow = vi.fn(() => null);
    const query = new Query(
      transport as never,
      { getRow, peekRow } as never,
      optimisticStore,
      schema,
    );

    const rows = query.peekQuery("tasks", { in: parent });

    expect(rows).toEqual([]);
    expect(transport.row).not.toHaveBeenCalled();
    expect(getRow).not.toHaveBeenCalled();
    expect(peekRow).not.toHaveBeenCalled();
  });

  it("emits one immediate local mutation notification for create and update", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });
    const project = await settle(db.create("projects", { name: "Website" }));
    const events: number[] = [];
    const unsubscribe = db.subscribeToLocalMutations(() => {
      events.push(Date.now());
    });

    const createReceipt = db.create("tasks", { title: "Ship v2" }, { in: project.ref });
    expect(events).toHaveLength(1);

    const task = await settle(createReceipt);
    events.length = 0;

    const updateReceipt = db.update("tasks", task.ref, { title: "Ship v3" });
    expect(events).toHaveLength(1);

    await settle(updateReceipt);
    unsubscribe();
  });

  it("watchQuery emits rows end-to-end through Vennbase", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });
    const project = await settle(db.create("projects", { name: "Website" }));
    const task = await settle(db.create("tasks", { title: "Ship v2" }, { in: project.ref }));

    const changes: string[][] = [];
    const watcher = db.watchQuery("tasks", {
      in: project.ref,
    }, {
      onChange: (rows) => {
        changes.push(rows.map((row) => row.id));
      },
    });

    await vi.waitFor(() => {
      expect(changes).toContainEqual([task.id]);
    });

    watcher.disconnect();
  });

  it("watchQuery resolves CURRENT_USER end-to-end through Vennbase", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });
    const project = await settle(db.create("projects", { name: "Game 1" }));
    const record = await settle(db.create("gameRecords", {
      gameRef: project.ref,
      role: "owner",
    }, {
      in: CURRENT_USER,
    }));

    const changes: string[][] = [];
    const watcher = db.watchQuery("gameRecords", {
      in: CURRENT_USER,
      where: { role: "owner" },
    }, {
      onChange: (rows) => {
        changes.push(rows.map((row) => row.id));
      },
    });

    await vi.waitFor(() => {
      expect(changes).toContainEqual([record.id]);
    });

    watcher.disconnect();
  });
});

describe("Query watchQuery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the initial result and skips unchanged snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const query = buildQueryForWatchTests();
    vi.spyOn(query, "query").mockImplementation(async () => [buildWatchRow("task_1", "Ship v2")] as never);

    const changes: string[] = [];
    const watcher = query.watchQuery("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        baseUrl: "https://worker.example",
      },
    }, {
      onChange: (rows) => {
        changes.push(rows.map((row) => row.id).join(","));
      },
    });

    await flushMicrotasks();
    expect(changes).toEqual(["task_1"]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(changes).toEqual(["task_1"]);

    watcher.disconnect();
  });

  it("watchQuery resets to five second polling after query changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const query = buildQueryForWatchTests();
    const queryTimes: number[] = [];
    vi.spyOn(query, "query").mockImplementation(async () => {
      queryTimes.push(Date.now());
      return Date.now() >= Date.parse("2026-03-13T00:01:15.000Z")
        ? [buildWatchRow("task_2", "Review PR")] as never
        : [buildWatchRow("task_1", "Ship v2")] as never;
    });

    const watcher = query.watchQuery("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        baseUrl: "https://worker.example",
      },
    }, { onChange() {} });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(queryTimes.at(-1)).toBe(Date.parse("2026-03-13T00:01:15.000Z"));

    const callCountAfterChange = queryTimes.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(queryTimes).toHaveLength(callCountAfterChange);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queryTimes.at(-1)).toBe(Date.parse("2026-03-13T00:01:20.000Z"));

    watcher.disconnect();
  });

  it("watchQuery reports errors and keeps polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const query = buildQueryForWatchTests();
    let callCount = 0;
    vi.spyOn(query, "query").mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("boom");
      return [buildWatchRow("task_1", "Ship v2")] as never;
    });

    const errors: string[] = [];
    const changes: string[] = [];
    const watcher = query.watchQuery("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        baseUrl: "https://worker.example",
      },
    }, {
      onChange: (rows) => { changes.push(rows.map((row) => row.id).join(",")); },
      onError: (error) => { errors.push((error as Error).message); },
    });

    await flushMicrotasks();
    expect(errors).toEqual(["boom"]);
    expect(changes).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(changes).toEqual(["task_1"]);

    watcher.disconnect();
  });

  it("watchQuery refresh forces an immediate poll and resets cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const query = buildQueryForWatchTests();
    const queryTimes: number[] = [];
    vi.spyOn(query, "query").mockImplementation(async () => {
      queryTimes.push(Date.now());
      return [buildWatchRow("task_1", "Ship v2")] as never;
    });

    const watcher = query.watchQuery("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        baseUrl: "https://worker.example",
      },
    }, { onChange() {} });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(74_000);
    expect(queryTimes.at(-1)).toBe(Date.parse("2026-03-13T00:01:00.000Z"));

    await watcher.refresh();
    expect(queryTimes.at(-1)).toBe(Date.parse("2026-03-13T00:01:14.000Z"));

    const callCountAfterRefresh = queryTimes.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(queryTimes).toHaveLength(callCountAfterRefresh);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queryTimes.at(-1)).toBe(Date.parse("2026-03-13T00:01:19.000Z"));

    watcher.disconnect();
  });
});
