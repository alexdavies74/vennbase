import { describe, expect, it } from "vitest";

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
    workerResolver: (owner, roomId) => `https://${owner}-federation.example/rooms/${roomId}`,
    deployWorker: async () => undefined,
  });
}

describe("PuterDb", () => {
  it("inserts, updates, and queries indexed rows", async () => {
    const network = new TestWorkerNetwork();
    const db = buildDb({ username: "alice", network });

    const project = await db.insert("projects", { name: "Website" });
    const task = await db.insert("tasks", { title: "Ship v2" }, { in: project.toRef() });

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

    const aliceProject = await aliceDb.insert("projects", { name: "Roadmap" });
    await aliceProject.members.add("bob", { role: "writer" });

    const bobProject = await bobDb.insert("projects", { name: "Bob scope" });
    const bobTask = await bobDb.insert("tasks", { title: "Review" }, { in: bobProject.toRef() });
    await bobTask.in.add(aliceProject.toRef());

    const tasks = await aliceDb.query("tasks", {
      in: aliceProject.toRef(),
    });

    expect(tasks.some((task) => task.id === bobTask.id)).toBe(true);
  });
});
