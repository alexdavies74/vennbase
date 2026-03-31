import { describe, expect, it } from "vitest";

import { createPrincipalProof, createRequestProof } from "../src/auth";
import { exportPublicJwk, generateP256KeyPair } from "../src/crypto";
import { RowWorker } from "../src/worker/core";
import { InMemoryKv } from "../src/worker/in-memory-kv";

async function jsonBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function rowEndpoint(rowId: string, endpoint: string): string {
  return `https://worker.example/rows/${encodeURIComponent(rowId)}/${endpoint}`;
}

function rowMemberRolesStorageKey(rowId: string): string {
  return `row:${rowId}:member_roles`;
}

const signerState = new Map<string, Promise<{ keyPair: CryptoKeyPair; publicKeyJwk: JsonWebKey }>>();

async function getSigner(username: string): Promise<{ keyPair: CryptoKeyPair; publicKeyJwk: JsonWebKey }> {
  const existing = signerState.get(username);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const keyPair = await generateP256KeyPair();
    const publicKeyJwk = await exportPublicJwk(keyPair.publicKey);
    return { keyPair, publicKeyJwk };
  })();
  signerState.set(username, promise);
  return promise;
}

async function authedRequest(args: {
  url: string;
  username: string;
  action: string;
  rowId: string;
  body?: object;
}): Promise<Request> {
  const signer = await getSigner(args.username);
  const principal = await createPrincipalProof({
    username: args.username,
    publicKeyJwk: signer.publicKeyJwk,
    privateKey: signer.keyPair.privateKey,
  });
  const requestProof = await createRequestProof({
    action: args.action,
    rowId: args.rowId,
    payload: args.body ?? {},
    principal,
    privateKey: signer.keyPair.privateKey,
  });

  return new Request(args.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      auth: {
        principal,
        request: requestProof,
      },
      payload: args.body ?? {},
    }),
  });
}

async function createRow(worker: RowWorker, rowId: string, rowName = "Rex"): Promise<Response> {
  return worker.handle(
    await authedRequest({
      url: "https://worker.example/rows",
      username: "owner",
      action: "rows/create",
      rowId,
      body: {
        rowId,
        rowName,
      },
    }),
  );
}

class CountingKv extends InMemoryKv {
  public listCalls = 0;

  override async list(prefix: string) {
    this.listCalls += 1;
    return super.list(prefix);
  }
}

class WorkerNetwork {
  private readonly workers = new Map<string, RowWorker>();

  register(baseUrl: string, worker: RowWorker): void {
    this.workers.set(baseUrl.replace(/\/+$/g, ""), worker);
  }

  async dispatch(
    mode: "full" | "local-only",
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const baseUrl = this.resolveBaseUrl(request.url);
    if (!baseUrl) {
      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: `No worker for ${request.url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const worker = this.workers.get(baseUrl);
    if (!worker) {
      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: `Worker missing for ${request.url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    return worker.handle(request, {
      workersExec: (nextUrl, nextInit) => {
        if (mode === "local-only" && this.resolveBaseUrl(nextUrl) !== baseUrl) {
          return Promise.resolve(new Response(JSON.stringify({
            code: "EXEC_SCOPE",
            message: "cross-worker exec blocked",
          }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }));
        }

        return this.dispatch(mode, nextUrl, nextInit);
      },
    });
  }

  private resolveBaseUrl(requestUrl: string): string | null {
    let best: string | null = null;
    for (const candidate of this.workers.keys()) {
      if (!requestUrl.startsWith(candidate)) continue;
      if (!best || candidate.length > best.length) best = candidate;
    }
    return best;
  }
}

describe("RowWorker", () => {
  it("enforces invite and members-only reads", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    const created = await createRow(worker, "row_1");
    expect(created.status).toBe(200);

    const ownerJoin = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_1", "row/join"),
        action: "row/join",
        rowId: "row_1",
        username: "owner",
        body: { username: "owner" },
      }),
    );
    expect(ownerJoin.status).toBe(200);
    expect((await jsonBody(ownerJoin)).role).toBe("editor");

    const guestJoinWithoutInvite = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_1", "row/join"),
        action: "row/join",
        rowId: "row_1",
        username: "guest",
        body: { username: "guest" },
      }),
    );

    expect(guestJoinWithoutInvite.status).toBe(401);
    expect((await jsonBody(guestJoinWithoutInvite)).code).toBe("INVITE_REQUIRED");

    const inviteResponse = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_1", "invite-token/create"),
        action: "invite-token/create",
        rowId: "row_1",
        username: "owner",
        body: {
          token: "invite_1",
          rowId: "row_1",
          invitedBy: "tampered",
          createdAt: 10,
          role: "editor",
        },
      }),
    );

    expect(inviteResponse.status).toBe(200);
    expect((await jsonBody(inviteResponse)).inviteToken).toMatchObject({
      token: "invite_1",
      rowId: "row_1",
      invitedBy: "owner",
    });

    const guestJoin = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_1", "row/join"),
        action: "row/join",
        rowId: "row_1",
        username: "guest",
        body: {
          username: "guest",
          inviteToken: "invite_1",
        },
      }),
    );

    expect(guestJoin.status).toBe(200);

    const directMembers = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_1", "members/direct"),
        action: "members/direct",
        rowId: "row_1",
        username: "owner",
      }),
    );

    expect(directMembers.status).toBe(200);
    expect((await jsonBody(directMembers)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: "owner", role: "editor" }),
      expect.objectContaining({ username: "guest", role: "editor" }),
    ]));

    const outsiderRead = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_1", "sync/poll"),
        action: "sync/poll",
        rowId: "row_1",
        username: "outsider",
        body: { sinceSequence: 0 },
      }),
    );

    expect(outsiderRead.status).toBe(401);
    expect((await jsonBody(outsiderRead)).code).toBe("UNAUTHORIZED");
  });

  it("grants submitter invites write-only inbox access", async () => {
    const kv = new InMemoryKv();
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv },
    );

    await createRow(worker, "project_submitter", "Inbox");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_submitter", "row/join"),
        action: "row/join",
        rowId: "project_submitter",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    const inviteResponse = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_submitter", "invite-token/create"),
        action: "invite-token/create",
        rowId: "project_submitter",
        username: "owner",
        body: {
          token: "invite_submitter",
          rowId: "project_submitter",
          invitedBy: "owner",
          createdAt: 10,
          role: "submitter",
        },
      }),
    );

    expect((await jsonBody(inviteResponse)).inviteToken).toMatchObject({
      token: "invite_submitter",
      role: "submitter",
    });

    const submitterJoin = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_submitter", "row/join"),
        action: "row/join",
        rowId: "project_submitter",
        username: "submitter",
        body: {
          username: "submitter",
          inviteToken: "invite_submitter",
        },
      }),
    );

    expect(submitterJoin.status).toBe(200);
    expect((await jsonBody(submitterJoin)).role).toBe("submitter");

    const submitterRole = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_submitter", "members/role"),
        action: "members/role",
        rowId: "project_submitter",
        username: "submitter",
        body: {},
      }),
    );
    expect(submitterRole.status).toBe(200);
    expect((await jsonBody(submitterRole)).role).toBe("submitter");

    const registerChild = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_submitter", "parents/register-child"),
        action: "parents/register-child",
        rowId: "project_submitter",
        username: "submitter",
        body: {
          childRef: {
            id: "task_submitter",
            collection: "tasks",
            baseUrl: "https://worker.example",
          },
          childOwner: "submitter",
          collection: "tasks",
          fields: {
            status: "todo",
            title: "New request",
            email: "private@example.com",
          },
          schema: {
            keyFields: ["status"],
          },
        },
      }),
    );
    expect(registerChild.status).toBe(200);

    for (const endpoint of [
      { endpoint: "row/get", action: "row/get", body: undefined },
      { endpoint: "fields/get", action: "fields/get", body: undefined },
      { endpoint: "sync/poll", action: "sync/poll", body: { sinceSequence: 0 } },
      { endpoint: "members/direct", action: "members/direct", body: undefined },
      { endpoint: "parents/list", action: "parents/list", body: {} },
      { endpoint: "invite-token/get", action: "invite-token/get", body: {} },
    ]) {
      const response = await worker.handle(
        await authedRequest({
          url: rowEndpoint("project_submitter", endpoint.endpoint),
          action: endpoint.action,
          rowId: "project_submitter",
          username: "submitter",
          body: endpoint.body,
        }),
      );

      expect(response.status).toBe(401);
      expect((await jsonBody(response)).code).toBe("UNAUTHORIZED");
    }

    const submitterQuery = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_submitter", "db/query"),
        action: "db/query",
        rowId: "project_submitter",
        username: "submitter",
        body: { collection: "tasks", select: "keys", orderBy: "status" },
      }),
    );

    expect(submitterQuery.status).toBe(200);
    const submitterQueryBody = await jsonBody(submitterQuery);
    expect(submitterQueryBody.rows).toEqual([
      expect.objectContaining({
        rowId: "task_submitter",
        fields: { status: "todo" },
      }),
    ]);
    expect((submitterQueryBody.rows as Array<Record<string, unknown>>)[0]).not.toHaveProperty("owner");

    const submitterFullQuery = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_submitter", "db/query"),
        action: "db/query",
        rowId: "project_submitter",
        username: "submitter",
        body: { collection: "tasks" },
      }),
    );
    expect(submitterFullQuery.status).toBe(401);
    expect((await jsonBody(submitterFullQuery)).code).toBe("UNAUTHORIZED");

    const ownerQuery = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_submitter", "db/query"),
        action: "db/query",
        rowId: "project_submitter",
        username: "owner",
        body: { collection: "tasks" },
      }),
    );

    expect(ownerQuery.status).toBe(200);
    expect((await jsonBody(ownerQuery)).rows).toEqual([
      expect.objectContaining({ rowId: "task_submitter", owner: "submitter", fields: { status: "todo" } }),
    ]);

    await expect(kv.get("row:project_submitter:child:tasks:submitter:task_submitter")).resolves.toMatchObject({
      fields: { status: "todo" },
    });
  });

  it("grants contributors readable access and owned-child submission only", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "project_contributor", "Roadmap");
    await createRow(worker, "task_foreign", "Foreign task");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "row/join"),
        action: "row/join",
        rowId: "project_contributor",
        username: "owner",
        body: { username: "owner" },
      }),
    );
    await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_foreign", "row/join"),
        action: "row/join",
        rowId: "task_foreign",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "members/add"),
        action: "members/add",
        rowId: "project_contributor",
        username: "owner",
        body: {
          username: "contributor",
          role: "contributor",
        },
      }),
    );
    await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_foreign", "members/add"),
        action: "members/add",
        rowId: "task_foreign",
        username: "owner",
        body: {
          username: "contributor",
          role: "editor",
        },
      }),
    );

    const contributorRole = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "members/role"),
        action: "members/role",
        rowId: "project_contributor",
        username: "contributor",
        body: {},
      }),
    );
    expect(contributorRole.status).toBe(200);
    expect((await jsonBody(contributorRole)).role).toBe("contributor");

    const readableFields = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "fields/get"),
        action: "fields/get",
        rowId: "project_contributor",
        username: "contributor",
        body: {},
      }),
    );
    expect(readableFields.status).toBe(200);

    const syncSend = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "sync/send"),
        action: "sync/send",
        rowId: "project_contributor",
        username: "contributor",
        body: {
          id: "msg_contributor",
          rowId: "project_contributor",
          body: { hello: "world" },
          createdAt: 100,
        },
      }),
    );
    expect(syncSend.status).toBe(401);
    expect((await jsonBody(syncSend)).code).toBe("UNAUTHORIZED");

    const registerOwned = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "parents/register-child"),
        action: "parents/register-child",
        rowId: "project_contributor",
        username: "contributor",
        body: {
          childRef: {
            id: "task_owned",
            collection: "tasks",
            baseUrl: "https://worker.example",
          },
          childOwner: "contributor",
          collection: "tasks",
          fields: {
            title: "Owned task",
          },
        },
      }),
    );
    expect(registerOwned.status).toBe(200);

    const updateOwned = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "parents/update-index"),
        action: "parents/update-index",
        rowId: "project_contributor",
        username: "contributor",
        body: {
          childRef: {
            id: "task_owned",
            collection: "tasks",
            baseUrl: "https://worker.example",
          },
          childOwner: "contributor",
          collection: "tasks",
          fields: {
            title: "Owned task updated",
          },
        },
      }),
    );
    expect(updateOwned.status).toBe(200);

    const registerForeign = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "parents/register-child"),
        action: "parents/register-child",
        rowId: "project_contributor",
        username: "contributor",
        body: {
          childRef: {
            id: "task_foreign",
            collection: "tasks",
            baseUrl: "https://worker.example",
          },
          childOwner: "owner",
          collection: "tasks",
          fields: {
            title: "Foreign task",
          },
        },
      }),
    );
    expect(registerForeign.status).toBe(401);
    expect((await jsonBody(registerForeign)).code).toBe("UNAUTHORIZED");

    const unregisterOwned = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "parents/unregister-child"),
        action: "parents/unregister-child",
        rowId: "project_contributor",
        username: "contributor",
        body: {
          childRef: {
            id: "task_owned",
            collection: "tasks",
            baseUrl: "https://worker.example",
          },
          childOwner: "contributor",
          collection: "tasks",
        },
      }),
    );
    expect(unregisterOwned.status).toBe(200);

    const unregisterForeign = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_contributor", "parents/unregister-child"),
        action: "parents/unregister-child",
        rowId: "project_contributor",
        username: "contributor",
        body: {
          childRef: {
            id: "task_foreign",
            collection: "tasks",
            baseUrl: "https://worker.example",
          },
          childOwner: "owner",
          collection: "tasks",
        },
      }),
    );
    expect(unregisterForeign.status).toBe(401);
    expect((await jsonBody(unregisterForeign)).code).toBe("UNAUTHORIZED");
  });

  it("blocks viewers from maintaining parent indexes", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "project_viewer", "Roadmap");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_viewer", "row/join"),
        action: "row/join",
        rowId: "project_viewer",
        username: "owner",
        body: { username: "owner" },
      }),
    );
    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_viewer", "members/add"),
        action: "members/add",
        rowId: "project_viewer",
        username: "owner",
        body: {
          username: "viewer",
          role: "viewer",
        },
      }),
    );

    const registerChild = await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_viewer", "parents/register-child"),
        action: "parents/register-child",
        rowId: "project_viewer",
        username: "viewer",
        body: {
          childRef: {
            id: "task_viewer",
            collection: "tasks",
            baseUrl: "https://worker.example",
          },
          childOwner: "viewer",
          collection: "tasks",
          fields: {
            title: "New task",
          },
        },
      }),
    );

    expect(registerChild.status).toBe(401);
    expect((await jsonBody(registerChild)).code).toBe("UNAUTHORIZED");
  });

  it("does not inherit submitter membership onto child rows", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "project_parent", "Inbox");
    await createRow(worker, "task_child", "Task");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_parent", "row/join"),
        action: "row/join",
        rowId: "project_parent",
        username: "owner",
        body: { username: "owner" },
      }),
    );
    await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_child", "row/join"),
        action: "row/join",
        rowId: "task_child",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_child", "parents/link-parent"),
        action: "parents/link-parent",
        rowId: "task_child",
        username: "owner",
        body: {
          parentRef: {
            id: "project_parent",
            collection: "projects",
            baseUrl: "https://worker.example",
          },
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_parent", "invite-token/create"),
        action: "invite-token/create",
        rowId: "project_parent",
        username: "owner",
        body: {
          token: "invite_submitter",
          rowId: "project_parent",
          invitedBy: "owner",
          createdAt: 10,
          role: "submitter",
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_parent", "row/join"),
        action: "row/join",
        rowId: "project_parent",
        username: "submitter",
        body: {
          username: "submitter",
          inviteToken: "invite_submitter",
        },
      }),
    );

    const inheritedRole = await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_child", "members/role"),
        action: "members/role",
        rowId: "task_child",
        username: "submitter",
        body: {},
      }),
    );

    expect(inheritedRole.status).toBe(401);
    expect((await jsonBody(inheritedRole)).code).toBe("UNAUTHORIZED");

    const effective = await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_child", "members/effective"),
        action: "members/effective",
        rowId: "task_child",
        username: "owner",
        body: {},
      }),
    );

    expect(effective.status).toBe(200);
    expect((await jsonBody(effective)).members).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ username: "submitter" })]),
    );
  });

  it("downgrades inherited contributor access to viewer on child rows", async () => {
    const network = new WorkerNetwork();
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );
    network.register("https://worker.example", worker);

    const run = async (args: Parameters<typeof authedRequest>[0]) =>
      network.dispatch("full", await authedRequest(args));

    await run({
      url: "https://worker.example/rows",
      action: "rows/create",
      rowId: "project_contributor_parent",
      username: "owner",
      body: {
        rowId: "project_contributor_parent",
        rowName: "Roadmap",
      },
    });
    await run({
      url: "https://worker.example/rows",
      action: "rows/create",
      rowId: "task_contributor_child",
      username: "owner",
      body: {
        rowId: "task_contributor_child",
        rowName: "Task",
      },
    });

    await run({
      url: rowEndpoint("project_contributor_parent", "row/join"),
      action: "row/join",
      rowId: "project_contributor_parent",
      username: "owner",
      body: { username: "owner" },
    });
    await run({
      url: rowEndpoint("task_contributor_child", "row/join"),
      action: "row/join",
      rowId: "task_contributor_child",
      username: "owner",
      body: { username: "owner" },
    });

    await run({
      url: rowEndpoint("task_contributor_child", "parents/link-parent"),
      action: "parents/link-parent",
      rowId: "task_contributor_child",
      username: "owner",
      body: {
        parentRef: {
          id: "project_contributor_parent",
          collection: "projects",
          baseUrl: "https://worker.example",
        },
      },
    });

    await run({
      url: rowEndpoint("project_contributor_parent", "members/add"),
      action: "members/add",
      rowId: "project_contributor_parent",
      username: "owner",
      body: {
        username: "contributor",
        role: "contributor",
      },
    });

    const inheritedRole = await run({
      url: rowEndpoint("task_contributor_child", "members/role"),
      action: "members/role",
      rowId: "task_contributor_child",
      username: "contributor",
      body: {},
    });
    expect(inheritedRole.status).toBe(200);
    expect((await jsonBody(inheritedRole)).role).toBe("viewer");

    const effective = await run({
      url: rowEndpoint("task_contributor_child", "members/effective"),
      action: "members/effective",
      rowId: "task_contributor_child",
      username: "owner",
      body: {},
    });
    expect(effective.status).toBe(200);
    expect((await jsonBody(effective)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        username: "contributor",
        role: "viewer",
        via: {
          id: "project_contributor_parent",
          collection: "projects",
          baseUrl: "https://worker.example",
        },
      }),
    ]));

    const registerGrandchild = await run({
      url: rowEndpoint("task_contributor_child", "parents/register-child"),
      action: "parents/register-child",
      rowId: "task_contributor_child",
      username: "contributor",
      body: {
        childRef: {
          id: "subtask_contributor",
          collection: "tasks",
          baseUrl: "https://worker.example",
        },
        childOwner: "contributor",
        collection: "tasks",
        fields: {
          title: "Nested task",
        },
      },
    });
    expect(registerGrandchild.status).toBe(401);
    expect((await jsonBody(registerGrandchild)).code).toBe("UNAUTHORIZED");
  });

  it("requires owner auth for row creation", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    const response = await worker.handle(
      await authedRequest({
        url: "https://worker.example/rows",
        action: "rows/create",
        rowId: "row_auth",
        username: "guest",
        body: {
          rowId: "row_auth",
          rowName: "Rex",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect((await jsonBody(response)).code).toBe("UNAUTHORIZED");
  });

  it("rejects join username spoofing", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_auth");

    const spoofedJoin = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_auth", "row/join"),
        action: "row/join",
        rowId: "row_auth",
        username: "owner",
        body: { username: "guest" },
      }),
    );

    expect(spoofedJoin.status).toBe(401);
    expect((await jsonBody(spoofedJoin)).code).toBe("UNAUTHORIZED");
  });

  it("stores canonical parent refs in row snapshots and unlinks by full ref", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "project_1", "Project");
    await createRow(worker, "task_1", "Task");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_1", "row/join"),
        action: "row/join",
        rowId: "project_1",
        username: "owner",
        body: { username: "owner" },
      }),
    );
    await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_1", "row/join"),
        action: "row/join",
        rowId: "task_1",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("project_1", "fields/set"),
        action: "fields/set",
        rowId: "project_1",
        username: "owner",
        body: {
          fields: { name: "Project" },
          collection: "projects",
        },
      }),
    );
    await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_1", "fields/set"),
        action: "fields/set",
        rowId: "task_1",
        username: "owner",
        body: {
          fields: { title: "Task" },
          collection: "tasks",
        },
      }),
    );

    const parentRef = {
      id: "project_1",
      collection: "projects",
      baseUrl: "https://worker.example",
    };

    const link = await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_1", "parents/link-parent"),
        action: "parents/link-parent",
        rowId: "task_1",
        username: "owner",
        body: { parentRef },
      }),
    );

    expect(link.status).toBe(200);
    expect((await jsonBody(link)).parentRefs).toEqual([expect.objectContaining(parentRef)]);

    const snapshot = await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_1", "row/get"),
        action: "row/get",
        rowId: "task_1",
        username: "owner",
      }),
    );

    expect(snapshot.status).toBe(200);
    expect((await jsonBody(snapshot))).toMatchObject({
      id: "task_1",
      collection: "tasks",
      parentRefs: [expect.objectContaining(parentRef)],
    });

    const unlink = await worker.handle(
      await authedRequest({
        url: rowEndpoint("task_1", "parents/unlink-parent"),
        action: "parents/unlink-parent",
        rowId: "task_1",
        username: "owner",
        body: { parentRef },
      }),
    );

    expect(unlink.status).toBe(200);
    expect((await jsonBody(unlink)).parentRefs).toEqual([]);
  });

  it("rejects non-scalar row fields", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_fields");
    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_fields", "row/join"),
        action: "row/join",
        rowId: "row_fields",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    const response = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_fields", "fields/set"),
        action: "fields/set",
        rowId: "row_fields",
        username: "owner",
        body: {
          fields: {
            title: { nested: true },
          },
          collection: "notes",
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(jsonBody(response)).resolves.toMatchObject({
      code: "BAD_REQUEST",
      message: "fields.title must be a string, number, boolean, or row ref",
    });
  });

  it("stamps message sender from authenticated requester", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_2");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_2", "row/join"),
        action: "row/join",
        rowId: "row_2",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_2", "invite-token/create"),
        action: "invite-token/create",
        rowId: "row_2",
        username: "owner",
        body: {
          token: "invite_2",
          rowId: "row_2",
          invitedBy: "owner",
          createdAt: 10,
          role: "editor",
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_2", "row/join"),
        action: "row/join",
        rowId: "row_2",
        username: "guest",
        body: {
          username: "guest",
          inviteToken: "invite_2",
        },
      }),
    );

    const post = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_2", "sync/send"),
        action: "sync/send",
        rowId: "row_2",
        username: "guest",
        body: {
          id: "msg_1",
          rowId: "row_2",
          body: { userType: "user", content: "hello" },
          createdAt: 100,
          signedBy: "owner",
        },
      }),
    );

    expect(post.status).toBe(200);
    expect((await jsonBody(post)).message).toMatchObject({
      id: "msg_1",
      rowId: "row_2",
      signedBy: "guest",
      sequence: 1,
    });
  });

  it("blocks sync sends from viewer members", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_reader");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_reader", "row/join"),
        action: "row/join",
        rowId: "row_reader",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_reader", "members/add"),
        action: "members/add",
        rowId: "row_reader",
        username: "owner",
        body: {
          username: "viewer",
          role: "viewer",
        },
      }),
    );

    const post = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_reader", "sync/send"),
        action: "sync/send",
        rowId: "row_reader",
        username: "viewer",
        body: {
          id: "msg_reader",
          rowId: "row_reader",
          body: { userType: "user", content: "hello" },
          createdAt: 100,
        },
      }),
    );

    expect(post.status).toBe(401);
    expect((await jsonBody(post)).code).toBe("UNAUTHORIZED");
  });

  it("allows editor members to manage membership", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_writer_manage");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_writer_manage", "row/join"),
        action: "row/join",
        rowId: "row_writer_manage",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_writer_manage", "members/add"),
        action: "members/add",
        rowId: "row_writer_manage",
        username: "owner",
        body: {
          username: "editor",
          role: "editor",
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_writer_manage", "row/join"),
        action: "row/join",
        rowId: "row_writer_manage",
        username: "editor",
        body: { username: "editor" },
      }),
    );

    const response = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_writer_manage", "members/add"),
        action: "members/add",
        rowId: "row_writer_manage",
        username: "editor",
        body: {
          username: "viewer",
          role: "viewer",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect((await jsonBody(response)).members).toEqual(expect.arrayContaining(["owner", "editor", "viewer"]));
  });

  it("blocks viewer members from managing membership", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_reader_manage");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_reader_manage", "row/join"),
        action: "row/join",
        rowId: "row_reader_manage",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_reader_manage", "members/add"),
        action: "members/add",
        rowId: "row_reader_manage",
        username: "owner",
        body: {
          username: "viewer",
          role: "viewer",
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_reader_manage", "row/join"),
        action: "row/join",
        rowId: "row_reader_manage",
        username: "viewer",
        body: { username: "viewer" },
      }),
    );

    const response = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_reader_manage", "members/add"),
        action: "members/add",
        rowId: "row_reader_manage",
        username: "viewer",
        body: {
          username: "guest",
          role: "viewer",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect((await jsonBody(response)).code).toBe("UNAUTHORIZED");
  });

  it("rejects admin as a member role", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_invalid_role");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_invalid_role", "row/join"),
        action: "row/join",
        rowId: "row_invalid_role",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    const response = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_invalid_role", "members/add"),
        action: "members/add",
        rowId: "row_invalid_role",
        username: "owner",
        body: {
          username: "editor",
          role: "admin",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).code).toBe("BAD_REQUEST");
  });

  it("does not grant editor access to legacy admin member roles", async () => {
    const kv = new InMemoryKv();
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv },
    );

    await createRow(worker, "row_legacy_role");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_legacy_role", "row/join"),
        action: "row/join",
        rowId: "row_legacy_role",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_legacy_role", "members/add"),
        action: "members/add",
        rowId: "row_legacy_role",
        username: "owner",
        body: {
          username: "guest",
          role: "editor",
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_legacy_role", "row/join"),
        action: "row/join",
        rowId: "row_legacy_role",
        username: "guest",
        body: { username: "guest" },
      }),
    );

    await kv.set(rowMemberRolesStorageKey("row_legacy_role"), { guest: "admin" });

    const sendResponse = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_legacy_role", "sync/send"),
        action: "sync/send",
        rowId: "row_legacy_role",
        username: "guest",
        body: {
          id: "msg_legacy",
          rowId: "row_legacy_role",
          body: { userType: "user", content: "hello" },
          createdAt: 100,
        },
      }),
    );

    expect(sendResponse.status).toBe(401);
    expect((await jsonBody(sendResponse)).code).toBe("UNAUTHORIZED");

    const membersResponse = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_legacy_role", "members/direct"),
        action: "members/direct",
        rowId: "row_legacy_role",
        username: "owner",
      }),
    );

    expect(membersResponse.status).toBe(200);
    expect((await jsonBody(membersResponse)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: "guest", role: "viewer" }),
    ]));
    await expect(kv.get(rowMemberRolesStorageKey("row_legacy_role"))).resolves.toEqual({ guest: "admin" });
  });

  it("returns messages sorted by createdAt and id", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_3");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_3", "row/join"),
        action: "row/join",
        rowId: "row_3",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_3", "sync/send"),
        action: "sync/send",
        rowId: "row_3",
        username: "owner",
        body: {
          id: "b",
          rowId: "row_3",
          body: { userType: "user", content: "b" },
          createdAt: 1000,
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_3", "sync/send"),
        action: "sync/send",
        rowId: "row_3",
        username: "owner",
        body: {
          id: "a",
          rowId: "row_3",
          body: { userType: "user", content: "a" },
          createdAt: 1000,
        },
      }),
    );

    const response = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_3", "sync/poll"),
        action: "sync/poll",
        rowId: "row_3",
        username: "owner",
        body: { sinceSequence: 0 },
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { messages: Array<{ id: string }> };
    expect(payload.messages.map((message) => message.id)).toEqual(["a", "b"]);
  });

  it("requires sinceSequence for message polling", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_req_seq");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_req_seq", "row/join"),
        action: "row/join",
        rowId: "row_req_seq",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    const response = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_req_seq", "sync/poll"),
        action: "sync/poll",
        rowId: "row_req_seq",
        username: "owner",
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("BAD_REQUEST");
  });

  it("uses row sequence to skip list reads when nothing changed", async () => {
    const kv = new CountingKv();
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv },
    );

    await createRow(worker, "row_seq");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_seq", "row/join"),
        action: "row/join",
        rowId: "row_seq",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_seq", "sync/send"),
        action: "sync/send",
        rowId: "row_seq",
        username: "owner",
        body: {
          id: "msg_1",
          rowId: "row_seq",
          body: { userType: "user", content: "hello" },
          createdAt: 1000,
        },
      }),
    );

    const noChangeResponse = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_seq", "sync/poll"),
        action: "sync/poll",
        rowId: "row_seq",
        username: "owner",
        body: { sinceSequence: 1 },
      }),
    );
    expect(noChangeResponse.status).toBe(200);
    const noChangePayload = (await noChangeResponse.json()) as {
      messages: Array<Record<string, unknown>>;
      latestSequence: number;
    };
    expect(noChangePayload.messages).toHaveLength(0);
    expect(noChangePayload.latestSequence).toBe(1);
    expect(kv.listCalls).toBe(0);

    const changedResponse = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_seq", "sync/poll"),
        action: "sync/poll",
        rowId: "row_seq",
        username: "owner",
        body: { sinceSequence: 0 },
      }),
    );
    expect(changedResponse.status).toBe(200);
    expect(kv.listCalls).toBe(1);
  });

  it("all members see all messages globally", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    await createRow(worker, "row_4");

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_4", "row/join"),
        action: "row/join",
        rowId: "row_4",
        username: "owner",
        body: { username: "owner" },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_4", "invite-token/create"),
        action: "invite-token/create",
        rowId: "row_4",
        username: "owner",
        body: {
          token: "invite_4",
          rowId: "row_4",
          invitedBy: "owner",
          createdAt: 10,
          role: "editor",
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_4", "row/join"),
        action: "row/join",
        rowId: "row_4",
        username: "guest",
        body: {
          username: "guest",
          inviteToken: "invite_4",
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_4", "sync/send"),
        action: "sync/send",
        rowId: "row_4",
        username: "guest",
        body: {
          id: "msg_guest",
          rowId: "row_4",
          body: { type: "yjs-update", data: "AAAA" },
          createdAt: 100,
        },
      }),
    );

    await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_4", "sync/send"),
        action: "sync/send",
        rowId: "row_4",
        username: "owner",
        body: {
          id: "msg_owner",
          rowId: "row_4",
          body: { type: "yjs-update", data: "BBBB" },
          createdAt: 120,
        },
      }),
    );

    for (const username of ["guest", "owner"]) {
      const response = await worker.handle(
        await authedRequest({
          url: rowEndpoint("row_4", "sync/poll"),
          action: "sync/poll",
          rowId: "row_4",
          username,
          body: { sinceSequence: 0 },
        }),
      );
      const payload = (await response.json()) as { messages: Array<{ id: string }> };
      expect(payload.messages.map((message) => message.id)).toEqual(["msg_guest", "msg_owner"]);
    }
  });

  it("allows puter-auth in CORS preflight", async () => {
    const worker = new RowWorker(
      {
        owner: "owner",
        workerUrl: "https://worker.example",
      },
      { kv: new InMemoryKv() },
    );

    const response = await worker.handle(
      new Request(rowEndpoint("row_cors", "row/join"), {
        method: "OPTIONS",
        headers: {
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,puter-auth",
        },
      }),
    );

    expect(response.status).toBe(204);
    const allowHeaders = response.headers.get("access-control-allow-headers");
    expect(allowHeaders).toContain("puter-auth");
  });

  it("reproduces inherited-membership failure when exec cannot cross worker boundaries", async () => {
    const network = new WorkerNetwork();
    const aliceBase = "https://alice.example";
    const bobBase = "https://bob.example";

    network.register(
      aliceBase,
      new RowWorker(
        { owner: "alice", workerUrl: aliceBase },
        { kv: new InMemoryKv() },
      ),
    );
    network.register(
      bobBase,
      new RowWorker(
        { owner: "bob", workerUrl: bobBase },
        { kv: new InMemoryKv() },
      ),
    );

    const run = async (mode: "full" | "local-only", args: Parameters<typeof authedRequest>[0]) =>
      network.dispatch(mode, await authedRequest(args));

    expect(await run("full", {
      url: `${aliceBase}/rows`,
      action: "rows/create",
      rowId: "dog_1",
      username: "alice",
      body: { rowId: "dog_1", rowName: "Rex" },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: rowEndpoint("dog_1", "row/join").replace("https://worker.example", aliceBase),
      action: "row/join",
      rowId: "dog_1",
      username: "alice",
      body: { username: "alice" },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: rowEndpoint("dog_1", "invite-token/create").replace("https://worker.example", aliceBase),
      action: "invite-token/create",
      rowId: "dog_1",
      username: "alice",
      body: { token: "invite_1", rowId: "dog_1", invitedBy: "alice", createdAt: 1, role: "editor" },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: rowEndpoint("dog_1", "row/join").replace("https://worker.example", aliceBase),
      action: "row/join",
      rowId: "dog_1",
      username: "bob",
      body: { username: "bob", inviteToken: "invite_1" },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: rowEndpoint("dog_1", "fields/set").replace("https://worker.example", aliceBase),
      action: "fields/set",
      rowId: "dog_1",
      username: "alice",
      body: { collection: "dogs", fields: { name: "Rex" } },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: `${bobBase}/rows`,
      action: "rows/create",
      rowId: "tag_1",
      username: "bob",
      body: { rowId: "tag_1", rowName: "friendly" },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: rowEndpoint("tag_1", "row/join").replace("https://worker.example", bobBase),
      action: "row/join",
      rowId: "tag_1",
      username: "bob",
      body: { username: "bob" },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: rowEndpoint("tag_1", "fields/set").replace("https://worker.example", bobBase),
      action: "fields/set",
      rowId: "tag_1",
      username: "bob",
      body: {
        collection: "tags",
        fields: { label: "friendly", createdBy: "bob", createdAt: 1 },
      },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: rowEndpoint("dog_1", "parents/register-child").replace("https://worker.example", aliceBase),
      action: "parents/register-child",
      rowId: "dog_1",
      username: "bob",
      body: {
        childRef: {
          id: "tag_1",
          collection: "tags",
          baseUrl: bobBase,
        },
        childOwner: "bob",
        collection: "tags",
        fields: { label: "friendly", createdBy: "bob", createdAt: 1 },
      },
    })).toMatchObject({ status: 200 });

    expect(await run("full", {
      url: rowEndpoint("tag_1", "parents/link-parent").replace("https://worker.example", bobBase),
      action: "parents/link-parent",
      rowId: "tag_1",
      username: "bob",
      body: {
        parentRef: {
          id: "dog_1",
          collection: "dogs",
          baseUrl: aliceBase,
        },
      },
    })).toMatchObject({ status: 200 });

    const parentQuery = await run("local-only", {
      url: rowEndpoint("dog_1", "db/query").replace("https://worker.example", aliceBase),
      action: "db/query",
      rowId: "dog_1",
      username: "alice",
      body: { collection: "tags" },
    });
    expect(parentQuery.status).toBe(200);
    expect((await jsonBody(parentQuery)).rows).toEqual([
      expect.objectContaining({
        rowId: "tag_1",
        owner: "bob",
        baseUrl: bobBase,
      }),
    ]);

    const childFieldsWithLocalOnlyExec = await run("local-only", {
      url: rowEndpoint("tag_1", "fields/get").replace("https://worker.example", bobBase),
      action: "fields/get",
      rowId: "tag_1",
      username: "alice",
    });
    expect(childFieldsWithLocalOnlyExec.status).toBe(401);
    expect((await jsonBody(childFieldsWithLocalOnlyExec)).message).toBe("Members only");

    const childFieldsWithFullExec = await run("full", {
      url: rowEndpoint("tag_1", "fields/get").replace("https://worker.example", bobBase),
      action: "fields/get",
      rowId: "tag_1",
      username: "alice",
    });
    expect(childFieldsWithFullExec.status).toBe(200);
    expect((await jsonBody(childFieldsWithFullExec)).fields).toMatchObject({
      label: "friendly",
      createdBy: "bob",
    });
  });
});
