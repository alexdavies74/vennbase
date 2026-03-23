import { afterEach, describe, expect, it, vi } from "vitest";

import { createMutationReceipt } from "../src/mutation-receipt";
import { OptimisticStore } from "../src/optimistic-store";
import { loadRememberedPerUserRow, rememberPerUserRow } from "../src/per-user-rows";
import { PutBase } from "../src/putbase";
import { Query } from "../src/query";
import { collection, defineSchema, field, index } from "../src/schema";
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
      status: field.string().default("todo"),
    },
    indexes: {
      byStatus: index("status"),
    },
  }),
  gameRecords: collection({
    in: ["user"],
    fields: {
      gameTarget: field.string(),
      role: field.string(),
    },
    indexes: {
      byGameTarget: index("gameTarget"),
    },
  }),
});

const INTERNAL_USER_SCOPE_ROW_KEY = "__putbase_user_scope_v1__";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function buildWatchRow(id: string, title: string) {
  return {
    id,
    collection: "tasks",
    owner: "alice",
    target: `https://worker.example/rows/${id}`,
    fields: { title, status: "todo" },
  };
}

function buildDb(args: {
  username: string;
  network: TestWorkerNetwork;
  backend?: BackendClient;
}): PutBase<typeof schema> {
  const workerBase = `https://${args.username}-federation.example`;

  args.network.register(
    workerBase,
    new RowWorker(
      { owner: args.username, workerUrl: workerBase },
      { kv: new InMemoryKv() },
    ),
  );

  return new PutBase({
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
}): Promise<PutBase<typeof schema>> {
  const db = buildDb(args);
  await db.ensureReady();
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

describe("PutBase rows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts, updates, and queries indexed rows", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const project = await db.put("projects", { name: "Website" });
    const task = await db.put("tasks", { title: "Ship v2" }, { in: project.toRef() });

    await db.update("tasks", task.toRef(), { status: "done" });

    const done = await db.query("tasks", {
      in: project.toRef(),
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

    const project = await db.put("projects", { name: "Website" });
    const task = await db.put("tasks", { title: "Ship v2" }, { in: project.toRef() });

    await db.update("tasks", task.toRef(), { status: "done" });

    const todo = await db.query("tasks", {
      in: project.toRef(),
      where: { status: "todo" },
    });
    const done = await db.query("tasks", {
      in: project.toRef(),
      where: { status: "done" },
    });

    expect(todo).toHaveLength(0);
    expect(done).toHaveLength(1);
    expect(done[0].id).toBe(task.id);
  });

  it("accepts a parent row handle for put and query inputs", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const project = await db.put("projects", { name: "Website" });
    const task = await db.put("tasks", { title: "Ship v2" }, { in: project });

    const tasks = await db.query("tasks", {
      in: project,
      where: { status: "todo" },
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].fields.title).toBe("Ship v2");
  });

  it("puts and queries user-scoped rows without explicit parents", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const record = await db.put("gameRecords", {
      gameTarget: "https://games.example/rows/game_1",
      role: "owner",
    });

    const records = await db.query("gameRecords", {
      index: "byGameTarget",
      value: "https://games.example/rows/game_1",
    });
    const parents = await record.in.list();

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(record.id);
    expect(parents).toEqual([
      expect.objectContaining({
        collection: "user",
        owner: "alice",
      }),
    ]);
  });

  it("reuses and recreates remembered user scope rows as needed", async () => {
    const network = new TestWorkerNetwork();
    const backend = { workers: {}, kv: new InMemoryKv() } as BackendClient;
    const db = await buildReadyDb({ username: "alice", network, backend });

    await db.put("gameRecords", {
      gameTarget: "https://games.example/rows/game_1",
      role: "owner",
    });

    const rememberedBefore = await loadRememberedPerUserRow(backend, "alice", INTERNAL_USER_SCOPE_ROW_KEY);
    expect(rememberedBefore).toBeTruthy();

    await db.query("gameRecords", { where: { role: "owner" } });
    const rememberedAfterReuse = await loadRememberedPerUserRow(backend, "alice", INTERNAL_USER_SCOPE_ROW_KEY);
    expect(rememberedAfterReuse?.target).toBe(rememberedBefore?.target);

    await rememberPerUserRow(backend, "alice", INTERNAL_USER_SCOPE_ROW_KEY, {
      target: "https://alice-federation.example/rows/row_missing",
    });

    await db.put("gameRecords", {
      gameTarget: "https://games.example/rows/game_2",
      role: "reader",
    });

    const recreated = await db.query("gameRecords", { where: { role: "reader" } });
    const rememberedAfterRecreate = await loadRememberedPerUserRow(backend, "alice", INTERNAL_USER_SCOPE_ROW_KEY);

    expect(recreated).toHaveLength(1);
    expect(rememberedAfterRecreate).toBeTruthy();
    expect(rememberedAfterRecreate?.target).toBeTruthy();
  });

  it("reuses row handles for the life of a row and updates fields in place", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const project = await db.put("projects", { name: "Website" });
    const task = await db.put("tasks", { title: "Ship v2" }, { in: project });

    const firstGet = await db.getRow("tasks", task);
    const secondGet = await db.getRow("tasks", task);
    const firstOpen = await db.openTarget(task.target);
    const secondOpen = await db.openTarget(task.target);

    expect(secondGet).toBe(firstGet);
    expect(firstOpen).toBe(firstGet);
    expect(secondOpen).toBe(firstGet);

    await db.update("tasks", task, { status: "done" });

    const afterChange = await db.getRow("tasks", task);
    expect(afterChange).toBe(firstGet);
    expect(afterChange.fields.status).toBe("done");
    expect(firstGet.fields.status).toBe("done");
  });

  it("supports cross-owner linking and scoped queries", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const aliceProject = await aliceDb.put("projects", { name: "Roadmap" });
    await aliceProject.members.add("bob", { role: "reader" }).settled;

    const bobProject = await bobDb.put("projects", { name: "Bob scope" });
    const bobTask = await bobDb.put("tasks", { title: "Review" }, { in: bobProject.toRef() });
    await bobTask.in.add(aliceProject.toRef()).settled;

    const tasks = await aliceDb.query("tasks", { in: aliceProject.toRef() });

    expect(tasks.some((task) => task.id === bobTask.id)).toBe(true);
  });

  it("lists canonical parent refs that can be reused in schema-aware queries", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const aliceProject = await aliceDb.put("projects", { name: "Roadmap" });
    await aliceProject.members.add("bob", { role: "reader" }).settled;

    const bobProject = await bobDb.put("projects", { name: "Bob scope" });
    const bobTask = await bobDb.put("tasks", { title: "Review" }, { in: bobProject.toRef() });
    await bobTask.in.add(aliceProject.toRef()).settled;

    const parents = await bobTask.in.list();
    expect(parents).toHaveLength(2);
    expect(parents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: aliceProject.id,
        collection: "projects",
        owner: "alice",
      }),
      expect.objectContaining({
        id: bobProject.id,
        collection: "projects",
        owner: "bob",
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

    const aliceProject = await aliceDb.put("projects", { name: "Roadmap" });
    await aliceProject.members.add("bob", { role: "reader" }).settled;

    const bobProject = await bobDb.put("projects", { name: "Bob scope" });
    const bobTask = await bobDb.put("tasks", { title: "Review" }, { in: bobProject.toRef() });
    await bobTask.in.add(aliceProject.toRef()).settled;

    const aliceTask = await aliceDb.openTarget(bobTask.target);
    expect(aliceTask.collection).toBe("tasks");
    if (aliceTask.collection !== "tasks") {
      throw new Error(`Expected tasks row, got ${aliceTask.collection}`);
    }

    const members = await aliceTask.members.effective();
    const aliceMember = members.find((member) => member.username === "alice");

    expect(aliceMember).toMatchObject({
      username: "alice",
      role: "writer",
      via: {
        id: aliceProject.id,
        collection: "projects",
        owner: "alice",
        target: aliceProject.target,
      },
    });
  });

  it("lets invite-joined writers update shared child rows", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = await buildReadyDb({ username: "alice", network });
    const bobDb = await buildReadyDb({ username: "bob", network });

    const project = await aliceDb.put("projects", { name: "Roadmap" });
    const task = await aliceDb.put("tasks", { title: "Review" }, { in: project.toRef() });
    const invite = aliceDb.createInviteToken(task);
    await invite.settled;
    const inviteLink = aliceDb.createInviteLink(task, invite.value.token);

    const joined = await bobDb.openInvite(inviteLink);
    expect(joined.collection).toBe("tasks");
    if (joined.collection !== "tasks") {
      throw new Error(`Expected tasks row, got ${joined.collection}`);
    }

    const updated = bobDb.update("tasks", joined.toRef(), { status: "done" });
    await updated.settled;

    const refreshed = await aliceDb.getRow("tasks", task.toRef());
    expect(refreshed.fields.status).toBe("done");

    const rows = await aliceDb.query("tasks", {
      in: project.toRef(),
      where: { status: "done" },
    });
    expect(rows.some((row) => row.id === task.id)).toBe(true);

    const directMembers = await aliceDb.listDirectMembers(task);
    expect(directMembers).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: "bob", role: "writer" }),
    ]));
  });

  it("rejects unknown and non-scalar field payloads", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    expect(
      () => db.put("projects", { name: "Website", extra: "ignored" } as never),
    ).toThrow("Unknown field projects.extra");

    expect(
      () => db.put("projects", { name: { label: "Website" } } as never),
    ).toThrow("Field projects.name must be a string");

    const project = await db.put("projects", { name: "Website" });
    const task = await db.put("tasks", { title: "Ship v2" }, { in: project.toRef() });

    expect(
      () => db.update("tasks", task.toRef(), { status: ["done"] } as never),
    ).toThrow("Field tasks.status must be a string");
  });

  it("rejects legacy row-worker URLs without /rows/{id}", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });

    const project = await db.put("projects", { name: "Website" });
    await db.put("tasks", { title: "Ship v2", status: "todo" }, { in: project.toRef() });

    const directTarget = `https://alice-row-${project.id}.example`;
    await expect(
      db.query("tasks", {
        in: { ...project.toRef(), target: directTarget },
        where: { status: "todo" },
      }),
    ).rejects.toThrow("Legacy non-federated row targets are no longer supported");
  });

  it("rejects query results when canonical row hydration fails", async () => {
    const transport = {
      row: vi.fn().mockReturnValue({
        request: vi.fn().mockResolvedValue({
          rows: [{
            rowId: "task_1",
            owner: "alice",
            target: "https://worker.example/rows/task_1/",
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
        owner: "alice",
        target: "https://worker.example/rows/project_1",
      },
    })).rejects.toThrow("canonical fetch failed");

    expect(getRow).toHaveBeenCalledWith("tasks", {
      id: "task_1",
      collection: "tasks",
      owner: "alice",
      target: "https://worker.example/rows/task_1",
    });
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
          rank: field.number(),
        },
        indexes: {
          byRank: index("rank"),
        },
      }),
    });

    const parentResponses = new Map([
      ["shelf_1", {
        rows: [
          {
            rowId: "card_2",
            owner: "alice",
            target: "https://worker.example/rows/card_2",
            collection: "cards",
            fields: { rank: 2 },
          },
          {
            rowId: "card_3",
            owner: "alice",
            target: "https://worker.example/rows/card_3",
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
            target: "https://worker.example/rows/card_1",
            collection: "cards",
            fields: { rank: 1 },
          },
          {
            rowId: "card_2",
            owner: "alice",
            target: "https://worker.example/rows/card_2",
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
    const getRow = vi.fn(async (_collection: string, row: { id: string; owner: string; target: string }) => ({
      id: row.id,
      collection: "cards",
      owner: row.owner,
      target: row.target,
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
          owner: "alice",
          target: "https://worker.example/rows/shelf_1",
        },
        {
          id: "shelf_2",
          collection: "shelves",
          owner: "alice",
          target: "https://worker.example/rows/shelf_2",
        },
      ],
      index: "byRank",
      order: "asc",
      limit: 2,
    });

    expect(rows.map((row) => row.id)).toEqual(["card_1", "card_2"]);
    expect(getRow.mock.calls.map(([, row]) => row.id)).toEqual(["card_1", "card_2"]);
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
      owner: "alice",
      target: "https://worker.example/rows/project_1",
    } as const;
    optimisticStore.beginCreate({
      row: parent,
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

  it("watchQuery emits rows end-to-end through PutBase", async () => {
    const network = new TestWorkerNetwork();
    const db = await buildReadyDb({ username: "alice", network });
    const project = await db.put("projects", { name: "Website" });
    const task = await db.put("tasks", { title: "Ship v2" }, { in: project.toRef() });

    const changes: string[][] = [];
    const watcher = db.watchQuery("tasks", {
      in: project.toRef(),
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
        owner: "alice",
        target: "https://worker.example/rows/project_1",
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
        owner: "alice",
        target: "https://worker.example/rows/project_1",
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
        owner: "alice",
        target: "https://worker.example/rows/project_1",
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
        owner: "alice",
        target: "https://worker.example/rows/project_1",
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
