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
    expect((await jsonBody(ownerJoin)).target).toBe("https://worker.example/rows/row_1");

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
      expect.objectContaining({ username: "owner", role: "admin" }),
      expect.objectContaining({ username: "guest", role: "writer" }),
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
      owner: "owner",
      target: "https://worker.example/rows/project_1",
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
    expect((await jsonBody(link)).parentRefs).toEqual([parentRef]);

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
      parentRefs: [parentRef],
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

  it("blocks sync sends from reader members", async () => {
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
          username: "reader",
          role: "reader",
        },
      }),
    );

    const post = await worker.handle(
      await authedRequest({
        url: rowEndpoint("row_reader", "sync/send"),
        action: "sync/send",
        rowId: "row_reader",
        username: "reader",
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
      body: { token: "invite_1", rowId: "dog_1", invitedBy: "alice", createdAt: 1 },
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
        childRowId: "tag_1",
        childOwner: "bob",
        childTarget: `${bobBase}/rows/tag_1`,
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
          owner: "alice",
          target: `${aliceBase}/rows/dog_1`,
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
        target: `${bobBase}/rows/tag_1`,
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
