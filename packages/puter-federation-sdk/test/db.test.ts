import { afterEach, describe, expect, it, vi } from "vitest";

import { PuterDb } from "../src/db/client";
import type { DbSchema } from "../src/db/types";
import { InMemoryKv } from "../src/worker/in-memory-kv";
import { RoomWorker } from "../src/worker/core";

function asUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

class TestWorkerNetwork {
  private readonly workers = new Map<string, RoomWorker>();

  register(baseUrl: string, worker: RoomWorker): void {
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
      if (!requestUrl.startsWith(candidate)) {
        continue;
      }

      if (!best || candidate.length > best.length) {
        best = candidate;
      }
    }

    return best;
  }
}

const schema: DbSchema = {
  projects: {
    fields: {
      name: { type: "string" },
    },
  },
  tasks: {
    in: ["projects"],
    fields: {
      title: { type: "string" },
      status: { type: "string", default: "todo" },
    },
    indexes: {
      byStatus: { fields: ["status"] },
    },
  },
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function buildWatchRow(id: string, title: string) {
  return {
    id,
    collection: "tasks",
    owner: "alice",
    workerUrl: `https://worker.example/rooms/${id}`,
    fields: {
      title,
      status: "todo",
    },
  };
}

function buildDb(args: {
  username: string;
  network: TestWorkerNetwork;
}): PuterDb<DbSchema> {
  const workerBase = `https://${args.username}-federation.example`;

  args.network.register(
    workerBase,
    new RoomWorker(
      {
        owner: args.username,
        workerUrl: workerBase,
      },
      { kv: new InMemoryKv() },
    ),
  );

  return new PuterDb({
    schema,
    identityProvider: async () => ({ username: args.username }),
    fetchFn: args.network.fetch as typeof fetch,
    appBaseUrl: `https://app.${args.username}.example`,
    deployWorker: async () => workerBase,
  });
}

describe("PuterDb", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts, updates, and queries indexed rows", async () => {
    const network = new TestWorkerNetwork();
    const db = buildDb({ username: "alice", network });

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

  it("supports cross-owner linking and scoped queries", async () => {
    const network = new TestWorkerNetwork();
    const aliceDb = buildDb({ username: "alice", network });
    const bobDb = buildDb({ username: "bob", network });

    const aliceProject = await aliceDb.put("projects", { name: "Roadmap" });
    await aliceProject.members.add("bob", { role: "reader" });

    const bobProject = await bobDb.put("projects", { name: "Bob scope" });
    const bobTask = await bobDb.put("tasks", { title: "Review" }, { in: bobProject.toRef() });
    await bobTask.in.add(aliceProject.toRef());

    const tasks = await aliceDb.query("tasks", {
      in: aliceProject.toRef(),
    });

    expect(tasks.some((task) => task.id === bobTask.id)).toBe(true);
  });

  it("rejects legacy room-worker URLs without /rooms/{id}", async () => {
    const network = new TestWorkerNetwork();
    const db = buildDb({ username: "alice", network });

    const project = await db.put("projects", { name: "Website" });
    await db.put("tasks", { title: "Ship v2", status: "todo" }, { in: project.toRef() });

    const directRoomWorkerUrl = `https://alice-room-${project.id}.example`;
    await expect(
      db.query("tasks", {
        in: {
          ...project.toRef(),
          workerUrl: directRoomWorkerUrl,
        },
        where: { status: "todo" },
      }),
    ).rejects.toThrow("Legacy non-federated room URLs are no longer supported");
  });

  it("watchQuery emits the initial result and skips unchanged snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T00:00:00.000Z"));

    const db = buildDb({ username: "alice", network: new TestWorkerNetwork() });
    vi.spyOn(db, "query").mockImplementation(async () => [buildWatchRow("task_1", "Ship v2")] as never);

    const changes: string[] = [];
    const watcher = db.watchQuery("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        owner: "alice",
        workerUrl: "https://worker.example/rooms/project_1",
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

    const db = buildDb({ username: "alice", network: new TestWorkerNetwork() });
    const queryTimes: number[] = [];
    vi.spyOn(db, "query").mockImplementation(async () => {
      queryTimes.push(Date.now());
      return Date.now() >= Date.parse("2026-03-13T00:01:15.000Z")
        ? [buildWatchRow("task_2", "Review PR")] as never
        : [buildWatchRow("task_1", "Ship v2")] as never;
    });

    const watcher = db.watchQuery("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        owner: "alice",
        workerUrl: "https://worker.example/rooms/project_1",
      },
    }, {
      onChange() {},
    });

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

    const db = buildDb({ username: "alice", network: new TestWorkerNetwork() });
    let callCount = 0;
    vi.spyOn(db, "query").mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("boom");
      }
      return [buildWatchRow("task_1", "Ship v2")] as never;
    });

    const errors: string[] = [];
    const changes: string[] = [];
    const watcher = db.watchQuery("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        owner: "alice",
        workerUrl: "https://worker.example/rooms/project_1",
      },
    }, {
      onChange: (rows) => {
        changes.push(rows.map((row) => row.id).join(","));
      },
      onError: (error) => {
        errors.push((error as Error).message);
      },
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

    const db = buildDb({ username: "alice", network: new TestWorkerNetwork() });
    const queryTimes: number[] = [];
    vi.spyOn(db, "query").mockImplementation(async () => {
      queryTimes.push(Date.now());
      return [buildWatchRow("task_1", "Ship v2")] as never;
    });

    const watcher = db.watchQuery("tasks", {
      in: {
        id: "project_1",
        collection: "projects",
        owner: "alice",
        workerUrl: "https://worker.example/rooms/project_1",
      },
    }, {
      onChange() {},
    });

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
