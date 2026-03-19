import { afterEach, describe, expect, it, vi } from "vitest";

import { PutBaseError } from "../src/errors";
import { PutBase } from "../src/putbase";
import { RowHandle } from "../src/row-handle";
import { collection, defineSchema, field } from "../src/schema";
import type { BackendClient } from "../src/types";
import { InMemoryKv } from "../src/worker/in-memory-kv";
import { RowWorker } from "../src/worker/core";

const runtimeGlobal = globalThis as { puter?: BackendClient };

function asUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function hashHostname(hostname: string): string {
  let hash = 0x811c9dc5;
  for (const char of hostname.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function workerMetadataKey(kind: "version" | "url", hostHash: string): string {
  return `putbase:federation-worker-${kind}:v2:owner:${hostHash}`;
}

function legacyWorkerMetadataKey(kind: "version" | "url", hostHash: string): string {
  const legacyNamespace = `${"puter"}-${"fed"}`;
  return `${legacyNamespace}:federation-worker-${kind}:v2:owner:${hostHash}`;
}

class MapKv {
  private readonly store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.store.has(key) ? (this.store.get(key) as T) : null;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const MINIMAL_SCHEMA = defineSchema({
  rows: collection({
    fields: {
      name: field.string().optional(),
    },
  }),
});

describe("PutBase", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete runtimeGlobal.puter;
  });

  it("opens a row target", async () => {
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);

        if (url.endsWith("/row/get")) {
          return new Response(
            JSON.stringify({
              id: "row_public",
              name: "Rex",
              owner: "owner",
              target: "https://worker.example/rows/row_public",
              createdAt: 1,
              collection: "rows",
              members: ["owner", "friend"],
              parentRefs: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if ((url.endsWith("/fields/get") || url.endsWith("/fields/set"))) {
          return new Response(
            JSON.stringify({ fields: { name: "Rex" }, collection: "rows" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const row = await db.openTarget("https://worker.example/rows/row_public");
    expect(row.id).toBe("row_public");
    expect(row.collection).toBe("rows");
    expect(row.owner).toBe("owner");
    expect(row.target).toBe("https://worker.example/rows/row_public");
    expect(row.fields.name).toBe("Rex");
  });

  it("uses globalThis.puter when no backend option is provided", async () => {
    runtimeGlobal.puter = {
      auth: {
        whoami: async () => ({ username: "owner" }),
      },
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {},
      kv: new MapKv(),
    } as BackendClient;

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
    });

    await expect(db.whoAmI()).resolves.toEqual({ username: "owner" });
  });

  it("returns signed-out session without triggering interactive login", async () => {
    let signInCalls = 0;
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      backend: {
        auth: {
          isSignedIn: () => false,
          signIn: async () => {
            signInCalls += 1;
            return null;
          },
        },
        workers: {},
        kv: new MapKv(),
      } as BackendClient,
    });

    await expect(db.getSession()).resolves.toEqual({ state: "signed-out" });
    await expect(db.whoAmI()).rejects.toMatchObject<Partial<PutBaseError>>({
      code: "SIGNED_OUT",
    });
    expect(signInCalls).toBe(0);
  });

  it("signs in explicitly and resolves the authenticated user", async () => {
    let signedIn = false;
    let signInCalls = 0;
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      backend: {
        auth: {
          isSignedIn: () => signedIn,
          whoami: async () => (signedIn ? { username: "owner" } : null),
          signIn: async () => {
            signInCalls += 1;
            signedIn = true;
            return null;
          },
        },
        workers: {},
        kv: new MapKv(),
      } as BackendClient,
    });

    await expect(db.signIn()).resolves.toEqual({ username: "owner" });
    await expect(db.getSession()).resolves.toEqual({
      state: "signed-in",
      user: { username: "owner" },
    });
    expect(signInCalls).toBe(1);
  });

  it("remembers, reopens, and clears per-user rows", async () => {
    const kv = new MapKv();
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      backend: { workers: {}, kv } as BackendClient,
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);
        if (url.endsWith("/row/get")) {
          return new Response(
            JSON.stringify({
              id: "row_1",
              name: "Rex",
              owner: "owner",
              target: "https://worker.example/rows/row_1",
              createdAt: 1,
              collection: "rows",
              members: ["owner"],
              parentRefs: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (url.endsWith("/fields/get")) {
          return new Response(
            JSON.stringify({ fields: { name: "Rex" }, collection: "rows" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(db.openRememberedPerUserRow("current-row")).resolves.toBeNull();

    await db.rememberPerUserRow("current-row", { target: "https://worker.example/rows/row_1" });
    await expect(db.openRememberedPerUserRow("current-row")).resolves.toMatchObject({
      id: "row_1",
      target: "https://worker.example/rows/row_1",
    });

    await db.clearRememberedPerUserRow("current-row");
    await expect(db.openRememberedPerUserRow("current-row")).resolves.toBeNull();
  });

  it("isolates remembered rows by username", async () => {
    const kv = new MapKv();
    const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
      const url = asUrl(input);
      const rowId = url.includes("friend_row") ? "friend_row" : "owner_row";
      if (url.endsWith("/row/get")) {
        return new Response(
          JSON.stringify({
            id: rowId,
            name: rowId,
            owner: rowId === "friend_row" ? "friend" : "owner",
            target: `https://worker.example/rows/${rowId}`,
            createdAt: 1,
            collection: "rows",
            members: ["owner"],
            parentRefs: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/fields/get")) {
        return new Response(
          JSON.stringify({ fields: { name: rowId }, collection: "rows" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    const ownerDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      backend: { workers: {}, kv } as BackendClient,
      fetchFn,
    });
    const friendDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "friend" }),
      backend: { workers: {}, kv } as BackendClient,
      fetchFn,
    });

    await ownerDb.rememberPerUserRow("current-row", { target: "https://worker.example/rows/owner_row" });
    await friendDb.rememberPerUserRow("current-row", { target: "https://worker.example/rows/friend_row" });

    await expect(ownerDb.openRememberedPerUserRow("current-row")).resolves.toMatchObject({
      id: "owner_row",
      target: "https://worker.example/rows/owner_row",
    });
    await expect(friendDb.openRememberedPerUserRow("current-row")).resolves.toMatchObject({
      id: "friend_row",
      target: "https://worker.example/rows/friend_row",
    });
  });

  it("explains how to provide Puter when signIn is called without a backend", async () => {
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
    });

    await expect(db.signIn()).rejects.toMatchObject<Partial<PutBaseError>>({
      code: "SIGNED_OUT",
      message: expect.stringContaining("No Puter client found."),
    });
    await expect(db.signIn()).rejects.toMatchObject<Partial<PutBaseError>>({
      message: expect.stringContaining("@heyputer/puter.js"),
    });
  });

  it("explains how to provide Puter when provisioning cannot find workers.create", async () => {
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      appBaseUrl: "https://app.example",
      backend: {
        auth: {
          whoami: async () => ({ username: "owner" }),
        },
        fs: {
          mkdir: async () => undefined,
          write: async () => undefined,
        },
        workers: {},
        kv: new MapKv(),
      } as BackendClient,
    });

    await expect(db.ensureReady()).rejects.toThrow("@heyputer/puter.js");
    await expect(db.ensureReady()).rejects.toThrow("workers.create");
  });

  it("waits for ambient backend availability once ensureReady is called", async () => {
    const kv = new MapKv();
    const appHost = "late-backend.example";
    const hostHash = hashHostname(appHost);
    const expectedWorkerName = `owner-${hostHash}-federation`;
    const deployedWorkerBase = `https://workers.example/${expectedWorkerName}`;
    const createStarted = deferred<void>();
    let createCalls = 0;

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      appBaseUrl: `https://${appHost}`,
    });

    runtimeGlobal.puter = {
      auth: {
        whoami: async () => ({ username: "owner" }),
      },
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {
        create: async () => {
          createCalls += 1;
          createStarted.resolve();
          return { success: true, url: deployedWorkerBase };
        },
      },
      kv,
    } as BackendClient;

    const readyPromise = db.ensureReady();
    await createStarted.promise;
    await expect(readyPromise).resolves.toBeUndefined();

    expect(createCalls).toBe(1);
    await expect(kv.get(workerMetadataKey("version", hostHash))).resolves.toSatisfy(
      (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
    );
    await expect(kv.get(workerMetadataKey("url", hostHash))).resolves.toBe(deployedWorkerBase);
  });

  it("fails openTarget when the worker omits collection metadata", async () => {
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);

        if (url.endsWith("/row/get")) {
          return new Response(
            JSON.stringify({
              id: "row_public",
              name: "Rex",
              owner: "owner",
              target: "https://worker.example/rows/row_public",
              createdAt: 1,
              collection: null,
              members: ["owner"],
              parentRefs: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if ((url.endsWith("/fields/get") || url.endsWith("/fields/set"))) {
          return new Response(
            JSON.stringify({ fields: { name: "Rex" }, collection: null }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(db.openTarget("https://worker.example/rows/row_public")).rejects.toThrow("Row collection is missing");
  });

  it("fails openTarget when the worker collection is off-schema", async () => {
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (input: RequestInfo | URL): Promise<Response> => {
        const url = asUrl(input);

        if (url.endsWith("/row/get")) {
          return new Response(
            JSON.stringify({
              id: "row_public",
              name: "Rex",
              owner: "owner",
              target: "https://worker.example/rows/row_public",
              createdAt: 1,
              collection: "foreign",
              members: ["owner"],
              parentRefs: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if ((url.endsWith("/fields/get") || url.endsWith("/fields/set"))) {
          return new Response(
            JSON.stringify({ fields: { name: "Rex" }, collection: "foreign" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(db.openTarget("https://worker.example/rows/row_public")).rejects.toThrow("Unknown collection: foreign");
  });

  it("throws PutBaseError for API failures", async () => {
    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: async (): Promise<Response> => new Response(
        JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    });

    await expect(db.openTarget("https://worker.example/rows/row_public")).rejects.toBeInstanceOf(
      PutBaseError,
    );
  });

  it("calls provided fetchFn without binding `this` to SDK instance", async () => {
    const contexts: unknown[] = [];

    const fetchFn = function (
      this: unknown,
      input: RequestInfo | URL,
    ): Promise<Response> {
      contexts.push(this);
      const url = asUrl(input);

      if (url.endsWith("/row/join")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }

      if (url.endsWith("/row/get")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "row_1",
              name: "Rex",
              owner: "owner",
              target: "https://workers.puter.site/owner-federation/rows/row_1",
              createdAt: 1,
              collection: "rows",
              members: ["owner"],
              parentRefs: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }

      if ((url.endsWith("/fields/get") || url.endsWith("/fields/set"))) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ fields: {}, collection: "rows" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof fetch;

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn,
    });

    const row = await db.openInvite("https://workers.puter.site/owner-federation/rows/row_1");

    expect(row.id).toBe("row_1");
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((value) => value === undefined)).toBe(true);
  });

  it("starts provisioning a host-scoped federation worker from constructor prewarm", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const kv = new MapKv();
    const appHost = "woof.example";
    const hostHash = hashHostname(appHost);
    const expectedWorkerName = `owner-${hostHash}-federation`;
    const deployedWorkerBase = `https://workers.example/${expectedWorkerName}`;
    let createdName: string | null = null;
    const createStarted = deferred<void>();

    const backend: BackendClient = {
      fs: {
        mkdir: async () => undefined,
        write: async () => undefined,
      },
      workers: {
        create: async (name: string) => {
          createdName = name;
          createStarted.resolve();
          return { success: true, url: deployedWorkerBase };
        },
      },
      kv,
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: `https://${appHost}`,
      backend,
      fetchFn: (() => Promise.reject(new Error("fetch should not be used in ensureReady"))) as typeof fetch,
    });

    await createStarted.promise;
    await db.ensureReady();

    expect(createdName).toBe(expectedWorkerName);
    await expect(kv.get(workerMetadataKey("version", hostHash))).resolves.toSatisfy(
      (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
    );
    await expect(kv.get(workerMetadataKey("url", hostHash))).resolves.toBe(deployedWorkerBase);
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining(`[putbase] deploying federation worker ${expectedWorkerName} for owner on ${appHost} at version `),
    );
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining(`[putbase] federation worker ready ${expectedWorkerName} version `),
    );
    consoleInfo.mockRestore();
  });

  it("shares constructor prewarm with ensureReady", async () => {
    const releaseCreate = deferred<{ url: string }>();
    const createStarted = deferred<void>();
    let deployCalls = 0;

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://prewarm-ensure.example",
      backend: {
        fs: { mkdir: async () => undefined, write: async () => undefined },
        workers: {
          create: async () => {
            deployCalls += 1;
            createStarted.resolve();
            return releaseCreate.promise;
          },
        },
        kv: new MapKv(),
      },
    });

    const readyPromise = db.ensureReady();
    await createStarted.promise;
    expect(deployCalls).toBe(1);

    releaseCreate.resolve({ url: "https://workers.example/owner-1234abcd-federation" });
    await expect(readyPromise).resolves.toBeUndefined();
    expect(deployCalls).toBe(1);
  });

  it("uses distinct federation workers for localhost apps on different ports", async () => {
    const kv = new MapKv();
    const createdNames: string[] = [];
    const firstHost = "localhost:5173";
    const secondHost = "localhost:4173";
    const firstHash = hashHostname(firstHost);
    const secondHash = hashHostname(secondHost);

    const backend: BackendClient = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
      workers: {
        create: async (name: string) => {
          createdNames.push(name);
          return { success: true, url: `https://workers.example/${name}` };
        },
      },
      kv,
    };

    const firstDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: `http://${firstHost}`,
      backend,
    });

    const secondDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: `http://${secondHost}`,
      backend,
    });

    await Promise.all([firstDb.ensureReady(), secondDb.ensureReady()]);

    expect(createdNames).toEqual(expect.arrayContaining([
      `owner-${firstHash}-federation`,
      `owner-${secondHash}-federation`,
    ]));
    expect(new Set(createdNames).size).toBe(2);
    await expect(kv.get(workerMetadataKey("url", firstHash))).resolves.toBe(
      `https://workers.example/owner-${firstHash}-federation`,
    );
    await expect(kv.get(workerMetadataKey("url", secondHash))).resolves.toBe(
      `https://workers.example/owner-${secondHash}-federation`,
    );
  });

  it("uses deployed shared worker URL returned by puter.workers.create", async () => {
    const requestedUrls: string[] = [];
    const deployedWorkerBase = "https://workers.example/owner-1234abcd-federation";
    let rowId: string | null = null;

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = asUrl(input);
      requestedUrls.push(url);

      if (url === `${deployedWorkerBase}/rows` && init?.body && typeof init.body === "string") {
        rowId = (JSON.parse(init.body) as { payload: { rowId: string } }).payload.rowId;
        return new Response(
          JSON.stringify({
            id: rowId,
            name: "Rex",
            owner: "owner",
            target: `${deployedWorkerBase}/rows/${rowId}`,
            createdAt: 1,
            collection: null,
            members: [],
            parentRefs: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (rowId && url === `${deployedWorkerBase}/rows/${rowId}/row/join`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (rowId && url === `${deployedWorkerBase}/rows/${rowId}/row/get`) {
        return new Response(
          JSON.stringify({
            id: rowId,
            name: "Rex",
            owner: "owner",
            target: `${deployedWorkerBase}/rows/${rowId}`,
            createdAt: 1,
            collection: null,
            members: ["owner"],
            parentRefs: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (
        rowId
        && (url === `${deployedWorkerBase}/rows/${rowId}/fields/get`
          || url === `${deployedWorkerBase}/rows/${rowId}/fields/set`)
      ) {
        return new Response(
          JSON.stringify({ fields: { name: "Rex" }, collection: "rows" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const backend: BackendClient = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
      workers: { create: async () => ({ success: true, url: deployedWorkerBase }) },
      kv: new MapKv(),
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://deployed-worker.example",
      backend,
      fetchFn: fetchFn as typeof fetch,
    });

    const row = await db.put("rows", { name: "Rex" });

    expect(row.target.startsWith(`${deployedWorkerBase}/rows/`)).toBe(true);
    expect(requestedUrls).toContain(`${deployedWorkerBase}/rows`);
    expect(requestedUrls.some((url) => url.endsWith("/row/join"))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/row/get"))).toBe(true);
  });

  it("shares constructor prewarm with put when provisioning the federation worker", async () => {
    const requestedUrls: string[] = [];
    const deployedWorkerBase = "https://workers.example/owner-1234abcd-federation";
    const releaseCreate = deferred<{ url: string }>();
    const createStarted = deferred<void>();
    let deployCalls = 0;
    let rowId: string | null = null;

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = asUrl(input);
      requestedUrls.push(url);

      if (url === `${deployedWorkerBase}/rows` && init?.body && typeof init.body === "string") {
        rowId = (JSON.parse(init.body) as { payload: { rowId: string } }).payload.rowId;
        return new Response(
          JSON.stringify({
            id: rowId,
            name: "Rex",
            owner: "owner",
            target: `${deployedWorkerBase}/rows/${rowId}`,
            createdAt: 1,
            collection: null,
            members: [],
            parentRefs: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (rowId && url === `${deployedWorkerBase}/rows/${rowId}/row/join`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (rowId && url === `${deployedWorkerBase}/rows/${rowId}/row/get`) {
        return new Response(
          JSON.stringify({
            id: rowId,
            name: "Rex",
            owner: "owner",
            target: `${deployedWorkerBase}/rows/${rowId}`,
            createdAt: 1,
            collection: null,
            members: ["owner"],
            parentRefs: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (
        rowId
        && (url === `${deployedWorkerBase}/rows/${rowId}/fields/get`
          || url === `${deployedWorkerBase}/rows/${rowId}/fields/set`)
      ) {
        return new Response(
          JSON.stringify({ fields: { name: "Rex" }, collection: "rows" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://prewarm-put.example",
      backend: {
        fs: { mkdir: async () => undefined, write: async () => undefined },
        workers: {
          create: async () => {
            deployCalls += 1;
            createStarted.resolve();
            return releaseCreate.promise;
          },
        },
        kv: new MapKv(),
      },
      fetchFn: fetchFn as typeof fetch,
    });

    const rowPromise = db.put("rows", { name: "Rex" });
    await createStarted.promise;
    expect(deployCalls).toBe(1);

    releaseCreate.resolve({ url: deployedWorkerBase });
    const row = await rowPromise;

    expect(deployCalls).toBe(1);
    expect(row.target.startsWith(`${deployedWorkerBase}/rows/`)).toBe(true);
    expect(requestedUrls).toContain(`${deployedWorkerBase}/rows`);
  });

  it("reuses shared worker from KV across SDK instances for same app host", async () => {
    const workerKv = new InMemoryKv();
    const kv = new MapKv();
    const deployedWorkerBase = "https://workers.example/owner-1234abcd-federation";
    let deployCalls = 0;

    const worker = new RowWorker(
      { owner: "owner", workerUrl: deployedWorkerBase },
      { kv: workerKv },
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const backend: BackendClient = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
      workers: {
        create: async () => {
          deployCalls += 1;
          return { success: true, url: deployedWorkerBase };
        },
      },
      kv,
    };

    const firstDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://reuse-kv.example",
      backend,
      fetchFn: fetchFn as typeof fetch,
    });

    const secondDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://reuse-kv.example",
      backend,
      fetchFn: fetchFn as typeof fetch,
    });

    const firstRow = await firstDb.put("rows", { name: "Rex" });
    const secondRow = await secondDb.put("rows", { name: "Spot" });

    expect(deployCalls).toBe(1);
    expect(firstRow.target).not.toBe(secondRow.target);
    expect(firstRow.target.startsWith(`${deployedWorkerBase}/rows/`)).toBe(true);
    expect(secondRow.target.startsWith(`${deployedWorkerBase}/rows/`)).toBe(true);
  });

  it("reuses existing scoped worker via workers.get before creating", async () => {
    const workerKv = new InMemoryKv();
    const kv = new MapKv();
    const existingWorkerBase = "https://workers.example/owner-deadbeef-federation";
    let deployCalls = 0;
    let getCalls = 0;

    const worker = new RowWorker(
      { owner: "owner", workerUrl: existingWorkerBase },
      { kv: workerKv },
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const backend: BackendClient = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
      workers: {
        get: async () => {
          getCalls += 1;
          return { url: existingWorkerBase };
        },
        create: async () => {
          deployCalls += 1;
          return { url: "https://workers.example/unexpected" };
        },
      },
      kv,
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://reuse-existing.example",
      backend,
      fetchFn: fetchFn as typeof fetch,
    });

    const row = await db.put("rows", { name: "Rex" });

    expect(getCalls).toBeGreaterThan(0);
    expect(deployCalls).toBe(0);
    expect(row.target.startsWith(`${existingWorkerBase}/rows/`)).toBe(true);
  });

  it("logs and redeploys when the stored federation worker version is stale", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const kv = new MapKv();
    const appHost = "upgrade.example";
    const hostHash = hashHostname(appHost);
    const workerName = `owner-${hostHash}-federation`;
    const staleWorkerBase = `https://workers.example/${workerName}-stale`;
    const upgradedWorkerBase = `https://workers.example/${workerName}`;
    let getCalls = 0;
    let createCalls = 0;

    await kv.set(legacyWorkerMetadataKey("version", hostHash), 1);
    await kv.set(legacyWorkerMetadataKey("url", hostHash), staleWorkerBase);

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: `https://${appHost}`,
      backend: {
        fs: { mkdir: async () => undefined, write: async () => undefined },
        workers: {
          get: async () => {
            getCalls += 1;
            return { url: staleWorkerBase };
          },
          create: async () => {
            createCalls += 1;
            return { url: upgradedWorkerBase };
          },
        },
        kv,
      },
    });

    await db.ensureReady();

    expect(getCalls).toBe(0);
    expect(createCalls).toBe(1);
    await expect(kv.get(workerMetadataKey("url", hostHash))).resolves.toBe(upgradedWorkerBase);
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining(
        `[putbase] upgrading federation worker ${workerName} for owner on ${appHost} from version 1 to `,
      ),
    );
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining(`[putbase] federation worker ready ${workerName} version `),
    );
    consoleInfo.mockRestore();
  });

  it("fails hard when scoped worker name collides", async () => {
    const kv = new MapKv();
    const backend: BackendClient = {
      fs: { mkdir: async () => undefined, write: async () => undefined },
      workers: {
        create: async () => {
          throw {
            success: false,
            error: { code: "already_in_use", message: "already in use", status: 409 },
          };
        },
      },
      kv,
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://collision.example",
      backend,
      fetchFn: (() => Promise.reject(new Error("fetch should not be used"))) as typeof fetch,
    });

    await expect(db.put("rows", { name: "Rex" })).rejects.toThrow("Federation worker name collision");
  });

  it("surfaces prewarm failures through ensureReady and retries on a later call", async () => {
    const firstAttemptStarted = deferred<void>();
    let deployCalls = 0;

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      appBaseUrl: "https://retry.example",
      backend: {
        fs: { mkdir: async () => undefined, write: async () => undefined },
        workers: {
          create: async () => {
            deployCalls += 1;
            if (deployCalls === 1) {
              firstAttemptStarted.resolve();
              throw {
                success: false,
                error: { code: "already_in_use", message: "already in use", status: 409 },
              };
            }

            return { url: "https://workers.example/owner-1234abcd-federation" };
          },
        },
        kv: new MapKv(),
      },
    });

    await firstAttemptStarted.promise;
    await flushMicrotasks();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(db.ensureReady()).rejects.toThrow("Federation worker name collision");
    expect(deployCalls).toBe(1);

    await expect(db.ensureReady()).resolves.toBeUndefined();
    expect(deployCalls).toBe(2);
  });

  it("uses backend.workers.exec when available", async () => {
    const execCalls: Array<{ url: string; init?: RequestInit }> = [];

    const backend = {
      workers: {
        exec: async (url: string, init?: RequestInit): Promise<Response> => {
          execCalls.push({ url, init });

          if (url.endsWith("/row/get")) {
            return new Response(
            JSON.stringify({
              id: "row_exec",
              name: "Rex",
              owner: "owner",
              target: "https://worker.example/rows/row_exec",
              createdAt: 1,
              collection: "rows",
              members: ["owner"],
              parentRefs: [],
            }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          if ((url.endsWith("/fields/get") || url.endsWith("/fields/set"))) {
            return new Response(
              JSON.stringify({ fields: { name: "Rex" }, collection: "rows" }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "Unexpected URL" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        },
      },
    } as BackendClient;

    const fetchFn = (): Promise<Response> => {
      throw new Error("fetch should not be called when workers.exec is available");
    };

    const db = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      backend,
      fetchFn: fetchFn as typeof fetch,
    });

    const row = await db.openTarget("https://worker.example/rows/row_exec");
    expect(row.id).toBe("row_exec");
    expect(execCalls.some((c) => c.url.endsWith("/row/get"))).toBe(true);
    expect(execCalls.some((c) => c.url.endsWith("/fields/get") || c.url.endsWith("/fields/set"))).toBe(true);
    expect(new Headers(execCalls[0].init?.headers).get("x-puter-username")).toBeNull();
  });

  it("can flush CRDT updates after client recreation", async () => {
    const worker = new RowWorker(
      { owner: "owner", workerUrl: "https://worker.example" },
      { kv: new InMemoryKv() },
    );

    await worker.handle(
      new Request("https://worker.example/rows", {
        method: "POST",
        headers: { "content-type": "application/json", "x-puter-username": "owner" },
        body: JSON.stringify({ rowId: "row_reload", rowName: "Rex" }),
      }),
    );

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(asUrl(input), init);
      return worker.handle(request);
    };

    const rowRef = {
      id: "row_reload",
      collection: "rows",
      owner: "owner",
      target: "https://worker.example/rows/row_reload",
    };

    const firstDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: fetchFn as typeof fetch,
    });

    const row1 = new RowHandle(firstDb, rowRef, {});
    const conn1 = row1.connectCrdt({
      applyRemoteUpdate() {},
      produceLocalUpdate: () => ({ type: "yjs-update", data: "AAAA" }),
    });
    await conn1.flush();
    conn1.disconnect();

    const secondDb = new PutBase({
      schema: MINIMAL_SCHEMA,
      identityProvider: async () => ({ username: "owner" }),
      fetchFn: fetchFn as typeof fetch,
    });

    const row2 = new RowHandle(secondDb, rowRef, {});
    const conn2 = row2.connectCrdt({
      applyRemoteUpdate() {},
      produceLocalUpdate: () => ({ type: "yjs-update", data: "BBBB" }),
    });
    await expect(conn2.flush()).resolves.toBeUndefined();
    conn2.disconnect();
  });
});
