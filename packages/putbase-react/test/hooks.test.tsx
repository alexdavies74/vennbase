// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RowHandle,
  collection,
  defineSchema,
  field,
  index,
  type DbMemberInfo,
  type DbRowRef,
  type PutBase,
} from "@putbase/core";

import {
  PutBaseProvider,
  useCurrentUser,
  useInviteFromLocation,
  usePutBase,
  useQuery,
  useRow,
  useRowTarget,
  useSession,
} from "../src/index";

const schema = defineSchema({
  dogs: collection({
    fields: {
      name: field.string(),
    },
  }),
  tags: collection({
    in: ["dogs"],
    fields: {
      label: field.string(),
      createdAt: field.number(),
    },
    indexes: {
      byCreatedAt: index("createdAt"),
    },
  }),
});

type TestSchema = typeof schema;

const backend = {
  addParent: async () => undefined,
  removeParent: async () => undefined,
  listParents: async () => [],
  addMember: async () => undefined,
  removeMember: async () => undefined,
  listDirectMembers: async () => [],
  listEffectiveMembers: async () => [],
  refreshFields: async () => ({}),
  connectCrdt: () => ({
    disconnect: () => undefined,
    flush: async () => undefined,
  }),
  listMembers: async () => [],
};

function makeDogRow(name: string) {
  return new RowHandle(
    backend,
    {
      id: "dog_1",
      collection: "dogs",
      owner: "alex",
      target: "https://worker.example/rows/dog_1",
    },
    { name },
  );
}

function makeTagRow(id: string, label: string) {
  return new RowHandle(
    backend,
    {
      id,
      collection: "tags",
      owner: "alex",
      target: `https://worker.example/rows/${id}`,
    },
    { label, createdAt: 1 },
  );
}

class FakeDb {
  username = "alex";
  sessionState: "signed-in" | "signed-out" = "signed-in";
  sessionPromise:
    | Promise<{ state: "signed-out" } | { state: "signed-in"; user: { username: string } }>
    | null = null;
  queryCalls = 0;
  getRowCalls = 0;
  openTargetCalls = 0;
  openInviteCalls = 0;
  lastInviteInput: string | null = null;
  ensureReadyCalls = 0;
  signInCalls = 0;
  failSession = false;
  dogName = "Rex";
  inviteDogName = "Buddy";
  queryRows = [makeTagRow("tag_1", "friendly")];
  activitySubscriber: (() => void) | null = null;

  async getSession(): Promise<{ state: "signed-out" } | { state: "signed-in"; user: { username: string } }> {
    if (this.failSession) {
      throw new Error("session failed");
    }

    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    if (this.sessionState === "signed-out") {
      return { state: "signed-out" };
    }

    return {
      state: "signed-in",
      user: { username: this.username },
    };
  }

  async signIn(): Promise<{ username: string }> {
    this.signInCalls += 1;
    this.sessionState = "signed-in";
    return { username: this.username };
  }

  async ensureReady(): Promise<void> {
    this.ensureReadyCalls += 1;
  }

  async whoAmI(): Promise<{ username: string }> {
    if (this.failSession) {
      throw new Error("whoami failed");
    }
    return { username: this.username };
  }

  async query(): Promise<typeof this.queryRows> {
    this.queryCalls += 1;
    return this.queryRows;
  }

  async getRow(): Promise<ReturnType<typeof makeDogRow>> {
    this.getRowCalls += 1;
    return makeDogRow(this.dogName);
  }

  async openTarget(): Promise<ReturnType<typeof makeDogRow>> {
    this.openTargetCalls += 1;
    return makeDogRow(this.dogName);
  }

  async openInvite(inviteInput: string): Promise<ReturnType<typeof makeDogRow>> {
    this.openInviteCalls += 1;
    this.lastInviteInput = inviteInput;
    return makeDogRow(this.inviteDogName);
  }

  async listParents(): Promise<DbRowRef[]> {
    return [];
  }

  async listMembers(): Promise<string[]> {
    return ["alex"];
  }

  async listDirectMembers(): Promise<Array<{ username: string; role: "admin" }>> {
    return [{ username: "alex", role: "admin" }];
  }

  async listEffectiveMembers(): Promise<Array<DbMemberInfo<TestSchema>>> {
    return [{ username: "alex", role: "admin", via: "direct" }];
  }

  async getExistingInviteToken(): Promise<null> {
    return null;
  }

  async createInviteToken() {
    return {
      token: "invite_1",
      rowId: "dog_1",
      invitedBy: "alex",
      createdAt: 1,
    };
  }

  createInviteLink(row: Pick<DbRowRef, "target">, token: string): string {
    return `${row.target}?token=${token}`;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(check: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flushMicrotasks();
      });
    }
  }

  throw lastError;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, reject, resolve };
}

async function renderApp(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
    await flushMicrotasks();
  });

  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("@putbase/react", () => {
  it("reads the client from provider context", async () => {
    const db = new FakeDb() as unknown as PutBase<TestSchema>;
    let seen: PutBase<TestSchema> | null = null;

    function Probe() {
      seen = usePutBase<TestSchema>();
      return null;
    }

    const app = await renderApp(
      <PutBaseProvider client={db}>
        <Probe />
      </PutBaseProvider>,
    );

    expect(seen).toBe(db);
    await app.unmount();
  });

  it("supports explicit client overrides and manual refresh for load-once hooks", async () => {
    const db = new FakeDb();
    let latest: ReturnType<typeof useCurrentUser<TestSchema>> | null = null;

    function Probe() {
      latest = useCurrentUser<TestSchema>({ client: db as unknown as PutBase<TestSchema> });
      return <div>{latest.data?.username ?? latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("success");
    expect(latest?.data).toEqual({ username: "alex" });

    db.username = "sam";
    await act(async () => {
      await latest?.refresh();
      await flushMicrotasks();
    });

    expect(latest?.data).toEqual({ username: "sam" });
    await app.unmount();
  });

  it("surfaces errors from load-once hooks", async () => {
    const db = new FakeDb();
    db.failSession = true;
    let latest: ReturnType<typeof useCurrentUser<TestSchema>> | null = null;

    function Probe() {
      latest = useCurrentUser<TestSchema>({ client: db as unknown as PutBase<TestSchema> });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("error");
    expect(latest?.error).toBeInstanceOf(Error);
    await app.unmount();
  });

  it("exposes session state and sign-in explicitly", async () => {
    const db = new FakeDb();
    db.sessionState = "signed-out";
    let latest: ReturnType<typeof useSession<TestSchema>> | null = null;

    function Probe() {
      latest = useSession<TestSchema>({ client: db as unknown as PutBase<TestSchema> });
      return <div>{latest.session.state}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("success");
    expect(latest?.session.state).toBe("signed-out");

    await act(async () => {
      await latest?.signIn();
      await flushMicrotasks();
    });

    expect(db.signInCalls).toBe(1);
    expect(latest?.session.state).toBe("signed-in");
    expect(latest?.data).toEqual({ state: "signed-in", user: { username: "alex" } });
    await app.unmount();
  });

  it("keeps session-dependent hooks idle while signed out", async () => {
    const db = new FakeDb();
    db.sessionState = "signed-out";
    const queryOptions = {
      in: {
        id: "dog_1",
        collection: "dogs",
        owner: "alex",
        target: "https://worker.example/rows/dog_1",
      },
      index: "byCreatedAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let latest: ReturnType<typeof useQuery<TestSchema, "tags">> | null = null;

    function Probe() {
      latest = useQuery("tags", queryOptions, { client: db as unknown as PutBase<TestSchema> });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("idle");
    expect(db.queryCalls).toBe(0);
    await app.unmount();
  });

  it("opens invite links from the current location after session resolution", async () => {
    window.history.replaceState(
      {},
      "",
      "/?target=https%3A%2F%2Fworker.example%2Frows%2Fdog_1&token=invite_1",
    );

    const db = new FakeDb();
    const session = deferred<{ state: "signed-in"; user: { username: string } }>();
    db.sessionPromise = session.promise;
    let latest: ReturnType<typeof useInviteFromLocation<TestSchema, ReturnType<typeof makeDogRow>>> | null = null;
    let openedDogName = "";

    function Probe() {
      latest = useInviteFromLocation<TestSchema, ReturnType<typeof makeDogRow>>({
        client: db as unknown as PutBase<TestSchema>,
        onOpen: (row) => {
          openedDogName = row.fields.name;
        },
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.hasInvite).toBe(true);
    expect(latest?.status).toBe("loading");
    expect(db.openInviteCalls).toBe(0);

    await act(async () => {
      session.resolve({ state: "signed-in", user: { username: "alex" } });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(db.openInviteCalls).toBe(1);
    expect(db.lastInviteInput).toBe("http://localhost:3000/?target=https%3A%2F%2Fworker.example%2Frows%2Fdog_1&token=invite_1");
    expect(openedDogName).toBe("Buddy");
    expect(window.location.search).toBe("");
    await app.unmount();
  });

  it("supports custom invite openers for app-specific post-processing", async () => {
    window.history.replaceState(
      {},
      "",
      "/?target=https%3A%2F%2Fworker.example%2Frows%2Fdog_1&token=invite_1",
    );

    const db = new FakeDb();
    const openInvite = vi.fn(async (inviteInput: string) => {
      const result = {
        inviteInput,
        kind: "profile" as const,
        row: makeDogRow("Buddy"),
      };
      return Object.assign(result, { self: result });
    });
    let latest: ReturnType<typeof useInviteFromLocation<TestSchema, {
      inviteInput: string;
      kind: "profile";
      row: ReturnType<typeof makeDogRow>;
      self?: unknown;
    }>> | null = null;

    function Probe() {
      latest = useInviteFromLocation<TestSchema, {
        inviteInput: string;
        kind: "profile";
        row: ReturnType<typeof makeDogRow>;
        self?: unknown;
      }>({
        client: db as unknown as PutBase<TestSchema>,
        open: async (inviteInput) => openInvite(inviteInput),
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    await waitFor(() => {
      expect(openInvite).toHaveBeenCalledWith(
        "http://localhost:3000/?target=https%3A%2F%2Fworker.example%2Frows%2Fdog_1&token=invite_1",
      );
      expect(latest?.status).toBe("success");
      expect(latest?.data?.inviteInput).toBe(
        "http://localhost:3000/?target=https%3A%2F%2Fworker.example%2Frows%2Fdog_1&token=invite_1",
      );
      expect(latest?.data?.row.fields.name).toBe("Buddy");
    });

    expect(db.openInviteCalls).toBe(0);
    await app.unmount();
  });

  it("dedupes identical live queries across consumers and updates on polling", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: {
        id: "dog_1",
        collection: "dogs",
        owner: "alex",
        target: "https://worker.example/rows/dog_1",
      },
      index: "byCreatedAt" as const,
      order: "asc" as const,
      limit: 100,
    };

    function Probe() {
      const result = useQuery("tags", queryOptions, { client: db as unknown as PutBase<TestSchema> });
      return <div>{result.rows.map((row) => row.fields.label).join(",")}</div>;
    }

    const app = await renderApp(
      <>
        <Probe />
        <Probe />
      </>,
    );

    expect(db.queryCalls).toBe(1);
    expect(app.container.textContent).toContain("friendly");

    db.queryRows = [makeTagRow("tag_1", "friendly"), makeTagRow("tag_2", "sleepy")];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(db.queryCalls).toBe(2);
    expect(app.container.textContent).toContain("friendly,sleepy");
    await app.unmount();
  });

  it("accepts a row handle in live query options", async () => {
    const db = new FakeDb();
    const boardHandle = makeDogRow("Rex");
    let latest: ReturnType<typeof useQuery<TestSchema, "tags">> | null = null;

    function Probe() {
      latest = useQuery("tags", {
        in: boardHandle,
        index: "byCreatedAt",
        order: "asc",
      }, { client: db as unknown as PutBase<TestSchema> });
      return <div>{latest.rows.map((row) => row.fields.label).join(",")}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(db.queryCalls).toBe(1);
    expect(latest?.status).toBe("success");
    expect(app.container.textContent).toContain("friendly");
    await app.unmount();
  });

  it("polls row reads reactively", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const rowRef: DbRowRef<"dogs"> = {
      id: "dog_1",
      collection: "dogs",
      owner: "alex",
      target: "https://worker.example/rows/dog_1",
    };
    let latest: ReturnType<typeof useRow<TestSchema, "dogs">> | null = null;

    function Probe() {
      latest = useRow("dogs", rowRef, { client: db as unknown as PutBase<TestSchema> });
      return <div>{latest.data?.fields.name ?? latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.data?.fields.name).toBe("Rex");

    db.dogName = "Max";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(latest?.data?.fields.name).toBe("Max");
    await app.unmount();
  });

  it("avoids rerendering when a live query snapshot is unchanged", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: {
        id: "dog_1",
        collection: "dogs",
        owner: "alex",
        target: "https://worker.example/rows/dog_1",
      },
      index: "byCreatedAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let renderCount = 0;

    function Probe() {
      renderCount += 1;
      useQuery("tags", queryOptions, { client: db as unknown as PutBase<TestSchema> });
      return null;
    }

    const app = await renderApp(<Probe />);
    const settledCount = renderCount;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(renderCount).toBe(settledCount);
    await app.unmount();
  });

  it("stays idle when a required input is missing", async () => {
    const db = new FakeDb();
    let latest: ReturnType<typeof useRowTarget<TestSchema>> | null = null;

    function Probe() {
      latest = useRowTarget<TestSchema>(null, { client: db as unknown as PutBase<TestSchema> });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("idle");
    expect(db.openTargetCalls).toBe(0);
    await app.unmount();
  });

  it("cleans up live polling when consumers unmount", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: {
        id: "dog_1",
        collection: "dogs",
        owner: "alex",
        target: "https://worker.example/rows/dog_1",
      },
      index: "byCreatedAt" as const,
      order: "asc" as const,
      limit: 100,
    };

    function Probe() {
      useQuery("tags", queryOptions, { client: db as unknown as PutBase<TestSchema> });
      return null;
    }

    const app = await renderApp(<Probe />);
    expect(db.queryCalls).toBe(1);

    await app.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();
    });

    expect(db.queryCalls).toBe(1);
  });

  it("accepts custom activity subscriptions", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: {
        id: "dog_1",
        collection: "dogs",
        owner: "alex",
        target: "https://worker.example/rows/dog_1",
      },
      index: "byCreatedAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let notifyActivity: (() => void) | null = null;

    function Probe() {
      useQuery("tags", queryOptions);
      return null;
    }

    const app = await renderApp(
      <PutBaseProvider
        client={db as unknown as PutBase<TestSchema>}
        subscribeToActivity={(notify) => {
          notifyActivity = notify;
          return () => undefined;
        }}
      >
        <Probe />
      </PutBaseProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_800_000);
      await flushMicrotasks();
    });

    const callsBeforeActivity = db.queryCalls;
    notifyActivity?.();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await flushMicrotasks();
    });
    expect(db.queryCalls).toBe(callsBeforeActivity);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();
    });
    expect(db.queryCalls).toBe(callsBeforeActivity + 1);

    await app.unmount();
  });
});
