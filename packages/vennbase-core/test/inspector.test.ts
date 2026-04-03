import { describe, expect, it } from "vitest";

import { Vennbase } from "../src/vennbase";
import { VennbaseInspector } from "../src/inspector";
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

class BrowserKv {
  private readonly store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.has(key) ? (structuredClone(this.store.get(key)) as T) : undefined;
  }

  async set<T = unknown>(key: string, value: T): Promise<boolean> {
    this.store.set(key, structuredClone(value));
    return true;
  }

  async del(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const results: Array<{ key: string; value: unknown }> = [];
    for (const [key, value] of this.store.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      results.push({
        key,
        value: structuredClone(value),
      });
    }

    results.sort((left, right) => left.key.localeCompare(right.key));
    return results;
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
      status: field.string().indexKey(),
    },
  }),
  notes: collection({
    in: ["projects"],
    fields: {
      body: field.string(),
      status: field.string().indexKey(),
    },
  }),
  recentProjects: collection({
    in: ["user"],
    fields: {
      projectRef: field.ref("projects").indexKey(),
    },
  }),
});

function buildDb(args: {
  username: string;
  network: TestWorkerNetwork;
  backend: BackendClient;
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
    fetchFn: args.network.fetch as typeof fetch,
    identityProvider: async () => ({ username: args.username }),
    appBaseUrl: `https://app.${args.username}.example`,
    deployWorker: async () => workerBase,
  });
}

function buildInspector(args: {
  username: string;
  network: TestWorkerNetwork;
  backend: BackendClient;
}): VennbaseInspector {
  return new VennbaseInspector({
    backend: args.backend,
    fetchFn: args.network.fetch as typeof fetch,
    identityProvider: async () => ({ username: args.username }),
  });
}

async function settle<T>(receipt: { committed: Promise<T> }): Promise<T> {
  return receipt.committed;
}

describe("VennbaseInspector", () => {
  it("lists saved rows and reads row details through existing endpoints", async () => {
    const network = new TestWorkerNetwork();
    const browserKv = new BrowserKv();
    const backend = { kv: browserKv } as BackendClient;
    const db = buildDb({ username: "alice", network, backend });
    const inspector = buildInspector({ username: "alice", network, backend });

    await db.getSession();
    const project = await settle(db.create("projects", { name: "Website" }));
    await db.saveRow("picked-project", project.ref);
    await settle(db.create("recentProjects", { projectRef: project.ref }, { in: CURRENT_USER }));

    const savedRows = await inspector.listSavedRows();
    const savedProject = savedRows.find((entry) => entry.key === "picked-project");

    expect(savedProject?.ref.id).toBe(project.id);

    const meta = await inspector.getRowMeta(project.ref);
    const fields = await inspector.getRowFields(project.ref);
    const directMembers = await inspector.getDirectMembers(project.ref);

    expect(meta.collection).toBe("projects");
    expect(fields).toEqual({
      fields: { name: "Website" },
      collection: "projects",
    });
    expect(directMembers).toEqual([
      { username: "alice", role: "editor" },
    ]);
  });

  it("queries mixed child rows without schema and crawls deduped graphs", async () => {
    const network = new TestWorkerNetwork();
    const browserKv = new BrowserKv();
    const backend = { kv: browserKv } as BackendClient;
    const db = buildDb({ username: "alice", network, backend });
    const inspector = buildInspector({ username: "alice", network, backend });

    await db.getSession();

    const projectA = await settle(db.create("projects", { name: "Alpha" }));
    const projectB = await settle(db.create("projects", { name: "Beta" }));
    const task = await settle(db.create("tasks", { title: "Ship", status: "todo" }, { in: projectA.ref }));
    const note = await settle(db.create("notes", { body: "Check logs", status: "todo" }, { in: projectA.ref }));
    await settle(db.addParent(task.ref, projectB.ref));

    const mixedChildren = await inspector.queryChildren(projectA.ref, {
      orderBy: "status",
      order: "asc",
      limit: 10,
      where: { status: "todo" },
    });

    expect(mixedChildren.map((row) => `${row.collection}:${row.id}`).sort()).toEqual([
      `notes:${note.id}`,
      `tasks:${task.id}`,
    ].sort());

    const crawl = await inspector.crawl([projectA.ref, projectB.ref], {
      maxRows: 10,
      childLimit: 10,
    });

    expect(crawl.nodes.filter((node) => node.ref.id === task.id)).toHaveLength(1);
    expect(crawl.edges.filter((edge) => edge.type === "child" && edge.to.id === task.id)).toHaveLength(2);
  });
});
