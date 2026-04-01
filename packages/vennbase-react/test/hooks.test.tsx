// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VENNBASE_INVITE_TARGET_PARAM,
  RowHandle,
  collection,
  defineSchema,
  field,
  type CrdtAdapter,
  type CrdtConnectCallbacks,
  type CrdtConnection,
  type DbAnonymousProjection,
  type DbMemberInfo,
  type Vennbase,
  type RowRef,
} from "@vennbase/core";

import {
  VennbaseProvider,
  useCrdt,
  useCurrentUser,
  useShareLink,
  useAcceptInviteFromUrl,
  useSavedRow,
  useVennbase,
  useQuery,
  useRow,
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
      createdAt: field.number().key(),
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

function dogRef(id = "dog_1"): RowRef<"dogs"> {
  return {
    id,
    collection: "dogs",
    baseUrl: "https://worker.example",
  };
}

function tagRef(id: string): RowRef<"tags"> {
  return {
    id,
    collection: "tags",
    baseUrl: "https://worker.example",
  };
}

function inviteUrl(row: RowRef, shareToken = "invite_1"): string {
  const url = new URL("http://localhost:3000/");
  url.searchParams.set(VENNBASE_INVITE_TARGET_PARAM, JSON.stringify({
    ref: row,
    shareToken,
  }));
  return url.toString();
}

function makeDogRow(name: string) {
  return new RowHandle(
    backend,
    dogRef(),
    "alex",
    { name },
  );
}

function makeTagRow(id: string, label: string) {
  return new RowHandle(
    backend,
    tagRef(id),
    "alex",
    { label, createdAt: 1 },
  );
}

function makeProjectedTagRow(id: string, createdAt: number): DbAnonymousProjection<TestSchema, "tags"> {
  return {
    kind: "anonymous-projection",
    id,
    collection: "tags",
    keyFields: { createdAt },
  };
}

class FakeDb {
  username = "alex";
  signedIn = true;
  sessionPromise:
    | Promise<{ signedIn: false } | { signedIn: true; user: { username: string } }>
    | null = null;
  queryCalls = 0;
  getRowCalls = 0;
  joinInviteCalls = 0;
  acceptInviteCalls = 0;
  lastInviteInput: string | null = null;
  getExistingShareTokenCallRoles: string[] = [];
  createShareTokenCallRoles: string[] = [];
  ensureReadyCalls = 0;
  signInCalls = 0;
  failSession = false;
  dogName = "Rex";
  inviteDogName = "Buddy";
  queryRows: Array<ReturnType<typeof makeTagRow> | DbAnonymousProjection<TestSchema, "tags">> = [makeTagRow("tag_1", "friendly")];
  nextQueryError: Error | null = null;
  nextQueryPromise: Promise<typeof this.queryRows> | null = null;
  activitySubscriber: (() => void) | null = null;
  localMutationListener: (() => void) | null = null;
  rememberedRows = new Map<string, RowRef>();
  failRememberedOpen = false;
  lastOpenedRow: RowRef | null = null;
  dogHandle: ReturnType<typeof makeDogRow> | null = null;
  inviteDogHandle: ReturnType<typeof makeDogRow> | null = null;
  pendingInviteOpen = false;

  private getStableDogHandle(name: string): ReturnType<typeof makeDogRow> {
    if (!this.dogHandle) {
      this.dogHandle = makeDogRow(name);
    } else if (this.dogHandle.fields.name !== name) {
      this.dogHandle.fields = { name };
    }

    return this.dogHandle;
  }

  private getStableInviteDogHandle(name: string): ReturnType<typeof makeDogRow> {
    if (!this.inviteDogHandle) {
      this.inviteDogHandle = makeDogRow(name);
    } else if (this.inviteDogHandle.fields.name !== name) {
      this.inviteDogHandle.fields = { name };
    }

    return this.inviteDogHandle;
  }

  async getSession(): Promise<{ signedIn: false } | { signedIn: true; user: { username: string } }> {
    if (this.failSession) {
      throw new Error("session failed");
    }

    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    if (!this.signedIn) {
      return { signedIn: false };
    }

    return {
      signedIn: true,
      user: { username: this.username },
    };
  }

  async signIn(): Promise<{ username: string }> {
    this.signInCalls += 1;
    this.signedIn = true;
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
    if (this.nextQueryPromise) {
      const pending = this.nextQueryPromise;
      this.nextQueryPromise = null;
      return pending;
    }
    if (this.nextQueryError) {
      const error = this.nextQueryError;
      this.nextQueryError = null;
      throw error;
    }
    return this.queryRows;
  }

  async getRow(row?: RowRef): Promise<ReturnType<typeof makeDogRow>> {
    this.getRowCalls += 1;
    this.lastOpenedRow = row ?? null;
    if (this.pendingInviteOpen) {
      this.pendingInviteOpen = false;
      return this.getStableInviteDogHandle(this.inviteDogName);
    }
    return this.getStableDogHandle(this.dogName);
  }

  async joinInvite(inviteInput: string): Promise<{ ref: RowRef; role: "viewer" | "submitter" }> {
    this.joinInviteCalls += 1;
    this.lastInviteInput = inviteInput;
    const url = new URL(inviteInput);
    const payload = url.searchParams.get(VENNBASE_INVITE_TARGET_PARAM);
    if (!payload) {
      throw new Error("missing invite payload");
    }

    const parsed = JSON.parse(payload) as { ref: RowRef; shareToken?: string };
    const role = parsed.shareToken === "invite_submitter" ? "submitter" : "viewer";
    this.pendingInviteOpen = role !== "submitter";

    return {
      ref: parsed.ref,
      role,
    };
  }

  async acceptInvite(inviteInput: string): Promise<ReturnType<typeof makeDogRow>> {
    this.acceptInviteCalls += 1;
    this.lastInviteInput = inviteInput;
    return this.getStableInviteDogHandle(this.inviteDogName);
  }

  async listParents(): Promise<RowRef[]> {
    return [];
  }

  async listMembers(): Promise<string[]> {
    return ["alex"];
  }

  async listDirectMembers(): Promise<Array<{ username: string; role: "editor" }>> {
    return [{ username: "alex", role: "editor" }];
  }

  async listEffectiveMembers(): Promise<Array<DbMemberInfo<TestSchema>>> {
    return [{ username: "alex", role: "editor", via: "direct" }];
  }

  async getExistingShareToken(_row?: RowRef, role: "editor" | "contributor" | "viewer" | "submitter" = "editor"): Promise<null> {
    this.getExistingShareTokenCallRoles.push(role);
    return null;
  }

  createShareToken(_row?: RowRef, role: "editor" | "contributor" | "viewer" | "submitter") {
    this.createShareTokenCallRoles.push(role);
    const value = {
      token: role === "submitter" ? "invite_submitter" : role === "contributor" ? "invite_contributor" : "invite_1",
      rowId: "dog_1",
      invitedBy: "alex",
      createdAt: 1,
      role,
    };
    return {
      value,
      committed: Promise.resolve(value),
      status: "committed" as const,
      error: undefined,
    };
  }

  createShareLink(row: RowRef, shareToken: { token: string }): string {
    return inviteUrl(row, shareToken.token);
  }

  async saveRow(key: string, row: RowRef): Promise<void> {
    this.rememberedRows.set(`${this.username}:${key}`, row);
  }

  async openSavedRow(key: string): Promise<ReturnType<typeof makeDogRow> | null> {
    const remembered = this.rememberedRows.get(`${this.username}:${key}`);
    if (!remembered) {
      return null;
    }

    if (this.failRememberedOpen) {
      throw new Error("remembered row failed");
    }
    return this.getRow(remembered);
  }

  async clearSavedRow(key: string): Promise<void> {
    this.rememberedRows.delete(`${this.username}:${key}`);
  }

  subscribeToLocalMutations(listener: () => void): () => void {
    this.localMutationListener = listener;
    return () => {
      if (this.localMutationListener === listener) {
        this.localMutationListener = null;
      }
    };
  }

  emitLocalMutation(): void {
    this.localMutationListener?.();
  }
}

function makeBinding<TValue>(initialValue: TValue) {
  let value = initialValue;
  let version = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    binding: {
      callbacks: {
        applyRemoteUpdate: () => undefined,
        produceLocalUpdate: () => null,
      },
      getValue: () => value,
      getVersion: () => version,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      reset() {
        version += 1;
        notify();
      },
    } satisfies CrdtAdapter<TValue>,
    setValue(nextValue: TValue) {
      value = nextValue;
      version += 1;
      notify();
    },
  };
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

  const render = async (nextElement: ReactElement) => {
    await act(async () => {
      root.render(nextElement);
      await flushMicrotasks();
    });
  };

  await render(element);

  return {
    container,
    render,
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
  window.history.replaceState({}, "", "/");
  document.body.innerHTML = "";
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("@vennbase/react", () => {
  it("exports hooks without requiring ambient Puter setup", () => {
    expect(typeof useVennbase).toBe("function");
  });
});

describe("@vennbase/react", () => {
  it("reads db from provider context", async () => {
    const db = new FakeDb() as unknown as Vennbase<TestSchema>;
    let seen: Vennbase<TestSchema> | null = null;

    function Probe() {
      seen = useVennbase<TestSchema>();
      return null;
    }

    const app = await renderApp(
      <VennbaseProvider db={db}>
        <Probe />
      </VennbaseProvider>,
    );

    expect(seen).toBe(db);
    await app.unmount();
  });

  it("connects CRDT bindings to rows and delegates flush", async () => {
    const flushSpy = vi.fn(async () => undefined);
    const connectSpy = vi.fn((_callbacks: CrdtConnectCallbacks): CrdtConnection => ({
      disconnect: () => undefined,
      flush: flushSpy,
    }));
    const row = {
      ref: dogRef(),
      connectCrdt: connectSpy,
    };
    const { binding, setValue } = makeBinding("idle");
    let latest: ReturnType<typeof useCrdt<string>> | null = null;

    function Probe() {
      latest = useCrdt(row, binding);
      return <div>{latest.value}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(latest?.status).toBe("connected");
    expect(latest?.value).toBe("idle");

    await act(async () => {
      setValue("updated");
      await flushMicrotasks();
    });

    expect(latest?.value).toBe("updated");
    expect(latest?.version).toBeGreaterThan(0);

    await act(async () => {
      await latest?.flush();
      await flushMicrotasks();
    });

    expect(flushSpy).toHaveBeenCalledTimes(1);
    await app.unmount();
  });

  it("resets CRDT bindings when rows change or become null", async () => {
    const disconnectSpy = vi.fn();
    const firstConnectSpy = vi.fn((_callbacks: CrdtConnectCallbacks): CrdtConnection => ({
      disconnect: disconnectSpy,
      flush: async () => undefined,
    }));
    const secondConnectSpy = vi.fn((_callbacks: CrdtConnectCallbacks): CrdtConnection => ({
      disconnect: disconnectSpy,
      flush: async () => undefined,
    }));
    const firstRow = {
      ref: dogRef(),
      connectCrdt: firstConnectSpy,
    };
    const secondRow = {
      ref: dogRef("dog_2"),
      connectCrdt: secondConnectSpy,
    };
    const { binding } = makeBinding("value");
    const resetSpy = vi.spyOn(binding, "reset");
    let latest: ReturnType<typeof useCrdt<string>> | null = null;

    function Probe(props: { activeRow: typeof firstRow | null }) {
      latest = useCrdt(props.activeRow, binding);
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe activeRow={firstRow} />);

    expect(latest?.status).toBe("connected");
    expect(firstConnectSpy).toHaveBeenCalledTimes(1);

    await app.render(<Probe activeRow={secondRow} />);
    expect(secondConnectSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    await app.render(<Probe activeRow={null} />);
    expect(latest?.status).toBe("idle");
    expect(resetSpy).toHaveBeenCalledTimes(2);

    await act(async () => {
      await latest?.flush();
      await flushMicrotasks();
    });

    await app.unmount();
  });

  it("supports explicit client overrides and manual refresh for load-once hooks", async () => {
    const db = new FakeDb();
    let latest: ReturnType<typeof useCurrentUser<TestSchema>> | null = null;

    function Probe() {
      latest = useCurrentUser<TestSchema>(db as unknown as Vennbase<TestSchema>);
      return <div>{latest.data?.username ?? latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("success");
    expect(latest?.data).toEqual({ username: "alex" });
    expect(latest?.isRefreshing).toBe(false);
    expect(latest?.refreshError).toBeUndefined();

    db.username = "sam";
    await act(async () => {
      await latest?.refresh();
      await flushMicrotasks();
    });

    expect(latest?.data).toEqual({ username: "sam" });
    expect(latest?.isRefreshing).toBe(false);
    expect(latest?.refreshError).toBeUndefined();
    await app.unmount();
  });

  it("surfaces errors from load-once hooks", async () => {
    const db = new FakeDb();
    db.failSession = true;
    let latest: ReturnType<typeof useCurrentUser<TestSchema>> | null = null;

    function Probe() {
      latest = useCurrentUser<TestSchema>(db as unknown as Vennbase<TestSchema>);
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("error");
    expect(latest?.error).toBeInstanceOf(Error);
    expect(latest?.refreshError).toBeUndefined();
    expect(latest?.isRefreshing).toBe(false);
    await app.unmount();
  });

  it("exposes session state and sign-in explicitly", async () => {
    const db = new FakeDb();
    db.signedIn = false;
    let latest: ReturnType<typeof useSession<TestSchema>> | null = null;

    function Probe() {
      latest = useSession<TestSchema>(db as unknown as Vennbase<TestSchema>);
      return <div>{latest.session ? String(latest.session.signedIn) : latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("success");
    expect(latest?.session).toEqual({ signedIn: false });

    await act(async () => {
      await latest?.signIn();
      await flushMicrotasks();
    });

    expect(db.signInCalls).toBe(1);
    expect(latest?.session).toEqual({ signedIn: true, user: { username: "alex" } });
    expect(latest?.data).toEqual({ signedIn: true, user: { username: "alex" } });
    await app.unmount();
  });

  it("keeps the session convenience field undefined while loading", async () => {
    const db = new FakeDb();
    const session = deferred<{ signedIn: true; user: { username: string } }>();
    db.sessionPromise = session.promise;
    let latest: ReturnType<typeof useSession<TestSchema>> | null = null;

    function Probe() {
      latest = useSession<TestSchema>(db as unknown as Vennbase<TestSchema>);
      return <div>{latest.session ? "ready" : latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("loading");
    expect(latest?.session).toBeUndefined();

    await act(async () => {
      session.resolve({ signedIn: true, user: { username: "alex" } });
      await flushMicrotasks();
    });

    expect(latest?.status).toBe("success");
    expect(latest?.session).toEqual({ signedIn: true, user: { username: "alex" } });
    await app.unmount();
  });

  it("keeps session-dependent hooks idle while signed out", async () => {
    const db = new FakeDb();
    db.signedIn = false;
    const queryOptions = {
      in: dogRef(),
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let latest: ReturnType<typeof useQuery<TestSchema, "tags">> | null = null;

    function Probe() {
      latest = useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("idle");
    expect(db.queryCalls).toBe(0);
    await app.unmount();
  });

  it("returns a named shareLink field for invite URLs", async () => {
    const db = new FakeDb();
    const rowRef = dogRef();
    let latest: ReturnType<typeof useShareLink<TestSchema>> | null = null;

    function Probe() {
      latest = useShareLink<TestSchema>(db as unknown as Vennbase<TestSchema>, rowRef, { role: "editor" });
      return <div>{latest.shareLink ?? latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    await waitFor(() => {
      expect(latest?.status).toBe("success");
      expect(latest?.shareLink).toBe(inviteUrl(rowRef));
    });

    expect(latest && "data" in latest).toBe(false);
    await app.unmount();
  });

  it("uses separate share-link cache entries for contributor and submitter invites", async () => {
    const db = new FakeDb();
    const rowRef = dogRef();
    let contributorLink: ReturnType<typeof useShareLink<TestSchema>> | null = null;
    let submitterLink: ReturnType<typeof useShareLink<TestSchema>> | null = null;

    function Probe() {
      contributorLink = useShareLink<TestSchema>(db as unknown as Vennbase<TestSchema>, rowRef, { role: "contributor" });
      submitterLink = useShareLink<TestSchema>(db as unknown as Vennbase<TestSchema>, rowRef, { role: "submitter" });
      return <div>{contributorLink.status}:{submitterLink.status}</div>;
    }

    const app = await renderApp(<Probe />);

    await waitFor(() => {
      expect(contributorLink?.shareLink).toBe(inviteUrl(rowRef, "invite_contributor"));
      expect(submitterLink?.shareLink).toBe(inviteUrl(rowRef, "invite_submitter"));
    });

    expect(db.getExistingShareTokenCallRoles.sort()).toEqual(["contributor", "submitter"]);
    expect(db.createShareTokenCallRoles.sort()).toEqual(["contributor", "submitter"]);
    await app.unmount();
  });

  it("opens invite links from the current location after session resolution", async () => {
    window.history.replaceState(
      {},
      "",
      inviteUrl(dogRef()),
    );

    const db = new FakeDb();
    const session = deferred<{ signedIn: true; user: { username: string } }>();
    db.sessionPromise = session.promise;
    let latest: ReturnType<typeof useAcceptInviteFromUrl<TestSchema>> | null = null;
    let openedDogName = "";

    function Probe() {
      latest = useAcceptInviteFromUrl<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        onOpen: (row) => {
          openedDogName = row.fields.name;
        },
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.hasInvite).toBe(true);
    expect(latest?.status).toBe("loading");
    expect(db.joinInviteCalls).toBe(0);

    await act(async () => {
      session.resolve({ signedIn: true, user: { username: "alex" } });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(db.joinInviteCalls).toBe(1);
    expect(db.getRowCalls).toBe(1);
    expect(db.lastInviteInput).toBe(inviteUrl(dogRef()));
    expect(openedDogName).toBe("Buddy");
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    await waitFor(() => {
      expect(latest?.hasInvite).toBe(false);
      expect(latest?.status).toBe("idle");
      expect(latest?.data).toBeUndefined();
    });
    await app.unmount();
  });

  it("keeps invite hooks loading until async onOpen completes", async () => {
    window.history.replaceState(
      {},
      "",
      inviteUrl(dogRef()),
    );

    const db = new FakeDb();
    const session = deferred<{ signedIn: true; user: { username: string } }>();
    const onOpen = deferred<void>();
    db.sessionPromise = session.promise;
    let latest: ReturnType<typeof useAcceptInviteFromUrl<TestSchema>> | null = null;
    let openedDogName = "";

    function Probe() {
      latest = useAcceptInviteFromUrl<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        onOpen: async (row) => {
          openedDogName = row.fields.name;
          await onOpen.promise;
        },
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    await act(async () => {
      session.resolve({ signedIn: true, user: { username: "alex" } });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(db.joinInviteCalls).toBe(1);
    });
    expect(openedDogName).toBe("Buddy");
    expect(latest?.status).toBe("loading");
    expect(latest?.data).toBeUndefined();
    expect(window.location.search).toContain(VENNBASE_INVITE_TARGET_PARAM);

    await act(async () => {
      onOpen.resolve();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(window.location.search).toBe("");
      expect(latest?.hasInvite).toBe(false);
      expect(latest?.status).toBe("idle");
      expect(latest?.data).toBeUndefined();
    });
    await app.unmount();
  });

  it("drops accepted location invites after the URL is cleared", async () => {
    window.history.replaceState(
      {},
      "",
      inviteUrl(dogRef()),
    );

    const db = new FakeDb();
    const session = deferred<{ signedIn: true; user: { username: string } }>();
    db.sessionPromise = session.promise;
    let latest: ReturnType<typeof useAcceptInviteFromUrl<TestSchema>> | null = null;

    function Probe() {
      latest = useAcceptInviteFromUrl<TestSchema>(db as unknown as Vennbase<TestSchema>);
      return <div>{latest.hasInvite ? latest.status : "no-invite"}</div>;
    }

    const app = await renderApp(<Probe />);

    await act(async () => {
      session.resolve({ signedIn: true, user: { username: "alex" } });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(window.location.search).toBe("");
      expect(latest?.hasInvite).toBe(false);
      expect(latest?.status).toBe("idle");
      expect(latest?.data).toBeUndefined();
    });
    expect(db.joinInviteCalls).toBe(1);
    await app.unmount();
  });

  it("returns joined results for submitter invites without opening the row", async () => {
    window.history.replaceState(
      {},
      "",
      inviteUrl(dogRef(), "invite_submitter"),
    );

    const db = new FakeDb();
    let latest: ReturnType<typeof useAcceptInviteFromUrl<TestSchema>> | null = null;
    let resolvedKind = "";
    let resolvedRole = "";
    let openedCalls = 0;

    function Probe() {
      latest = useAcceptInviteFromUrl<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        clearInviteParams: false,
        onOpen: () => {
          openedCalls += 1;
        },
        onResolve: (result) => {
          resolvedKind = result.kind;
          resolvedRole = result.role;
        },
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    await waitFor(() => {
      expect(latest?.status).toBe("success");
      expect(latest?.data).toEqual({
        kind: "joined",
        ref: dogRef(),
        role: "submitter",
      });
    });

    expect(db.joinInviteCalls).toBe(1);
    expect(db.getRowCalls).toBe(0);
    expect(openedCalls).toBe(0);
    expect(resolvedKind).toBe("joined");
    expect(resolvedRole).toBe("submitter");
    await app.unmount();
  });

  it("reports onResolve failures without clearing the invite URL", async () => {
    window.history.replaceState(
      {},
      "",
      inviteUrl(dogRef()),
    );

    const db = new FakeDb();
    const session = deferred<{ signedIn: true; user: { username: string } }>();
    db.sessionPromise = session.promise;
    let latest: ReturnType<typeof useAcceptInviteFromUrl<TestSchema>> | null = null;

    function Probe() {
      latest = useAcceptInviteFromUrl<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        onResolve: async () => {
          throw new Error("activate failed");
        },
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    await act(async () => {
      session.resolve({ signedIn: true, user: { username: "alex" } });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    await waitFor(() => {
      expect(latest?.status).toBe("error");
      expect(latest?.error).toBeInstanceOf(Error);
      expect((latest?.error as Error | undefined)?.message).toBe("activate failed");
    });
    expect(latest?.data).toBeUndefined();
    expect(window.location.search).toContain(VENNBASE_INVITE_TARGET_PARAM);
    await app.unmount();
  });

  it("ignores non-invite routes that happen to use a target query param", async () => {
    window.history.replaceState(
      {},
      "",
      "/game?target=https%3A%2F%2Fworker.example%2Frows%2Fdog_1",
    );

    const db = new FakeDb();
    let latest: ReturnType<typeof useAcceptInviteFromUrl<TestSchema>> | null = null;

    function Probe() {
      latest = useAcceptInviteFromUrl<TestSchema>(db as unknown as Vennbase<TestSchema>);
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.hasInvite).toBe(false);
    expect(latest?.inviteInput).toBeNull();
    expect(latest?.status).toBe("idle");
    expect(db.joinInviteCalls).toBe(0);
    await app.unmount();
  });

  it("returns opened invite details for readable invites", async () => {
    window.history.replaceState(
      {},
      "",
      inviteUrl(dogRef()),
    );

    const db = new FakeDb();
    let latest: ReturnType<typeof useAcceptInviteFromUrl<TestSchema>> | null = null;

    function Probe() {
      latest = useAcceptInviteFromUrl<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        clearInviteParams: false,
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    await waitFor(() => {
      expect(latest?.status).toBe("success");
      expect(latest?.data).toMatchObject({
        kind: "opened",
        ref: dogRef(),
        role: "viewer",
      });
      expect(latest?.data?.kind === "opened" ? latest.data.row.fields.name : null).toBe("Buddy");
    });

    expect(db.joinInviteCalls).toBe(1);
    expect(db.getRowCalls).toBe(1);
    expect(window.location.search).toContain(VENNBASE_INVITE_TARGET_PARAM);
    await app.unmount();
  });

  it("lets invite handlers persist rows explicitly for later restore", async () => {
    window.history.replaceState(
      {},
      "",
      inviteUrl(dogRef("dog_2")),
    );

    const db = new FakeDb();
    let latestInvite: ReturnType<typeof useAcceptInviteFromUrl<TestSchema>> | null = null;

    function InviteProbe() {
      latestInvite = useAcceptInviteFromUrl<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        onOpen: async (row) => {
          await db.saveRow("myDog", row.ref);
        },
      });
      return <div>{latestInvite.status}</div>;
    }

    const inviteApp = await renderApp(<InviteProbe />);

    await waitFor(() => {
      expect(latestInvite?.hasInvite).toBe(false);
    });

    expect(db.joinInviteCalls).toBe(1);
    expect(db.acceptInviteCalls).toBe(0);
    expect(db.rememberedRows.get("alex:myDog")).toEqual(dogRef());
    expect(window.location.search).toBe("");
    await inviteApp.unmount();

    let latestSaved: ReturnType<typeof useSavedRow<TestSchema>> | null = null;

    function SavedProbe() {
      latestSaved = useSavedRow<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        key: "myDog",
      });
      return <div>{latestSaved.data?.fields.name ?? latestSaved.status}</div>;
    }

    const savedApp = await renderApp(<SavedProbe />);

    await waitFor(() => {
      expect(latestSaved?.status).toBe("success");
      expect(latestSaved?.data?.fields.name).toBe("Rex");
    });

    await savedApp.unmount();
  });

  it("keeps per-user rows idle while signed out", async () => {
    const db = new FakeDb();
    db.signedIn = false;
    let latest: ReturnType<typeof useSavedRow<TestSchema>> | null = null;

    function Probe() {
      latest = useSavedRow<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        key: "myDog",
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("idle");
    expect(db.getRowCalls).toBe(0);
    expect(db.acceptInviteCalls).toBe(0);
    await app.unmount();
  });

  it("restores a remembered per-user row after session resolution", async () => {
    const db = new FakeDb();
    db.rememberedRows.set("alex:myDog", dogRef());
    const session = deferred<{ signedIn: true; user: { username: string } }>();
    db.sessionPromise = session.promise;
    let latest: ReturnType<typeof useSavedRow<TestSchema>> | null = null;

    function Probe() {
      latest = useSavedRow<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        key: "myDog",
      });
      return <div>{latest.data?.fields.name ?? latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("loading");
    expect(db.getRowCalls).toBe(0);

    await act(async () => {
      session.resolve({ signedIn: true, user: { username: "alex" } });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(latest?.status).toBe("success");
    expect(latest?.data?.fields.name).toBe("Rex");
    expect(db.getRowCalls).toBe(1);
    expect(db.lastOpenedRow).toEqual(dogRef());
    await app.unmount();
  });

  it("remembers and clears per-user rows locally without reopening", async () => {
    const db = new FakeDb();
    let latest: ReturnType<typeof useSavedRow<TestSchema>> | null = null;

    function Probe() {
      latest = useSavedRow<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        key: "myDog",
      });
      return <div>{latest.data?.fields.name ?? "empty"}</div>;
    }

    const app = await renderApp(<Probe />);

    await waitFor(() => {
      expect(latest?.status).toBe("success");
      expect(latest?.data).toBeNull();
    });

    await act(async () => {
      await latest?.save(makeDogRow("Buddy"));
      await flushMicrotasks();
    });

    expect(latest?.data?.fields.name).toBe("Buddy");
    expect(db.rememberedRows.get("alex:myDog")).toEqual(dogRef());
    expect(db.getRowCalls).toBe(0);

    await act(async () => {
      await latest?.clear();
      await flushMicrotasks();
    });

    expect(latest?.data).toBeNull();
    expect(db.rememberedRows.get("alex:myDog")).toBeUndefined();
    expect(db.getRowCalls).toBe(0);
    await app.unmount();
  });

  it("clears invalid remembered targets when reopening fails", async () => {
    const db = new FakeDb();
    db.rememberedRows.set("alex:myDog", dogRef());
    db.failRememberedOpen = true;
    let latest: ReturnType<typeof useSavedRow<TestSchema>> | null = null;

    function Probe() {
      latest = useSavedRow<TestSchema>(db as unknown as Vennbase<TestSchema>, {
        key: "myDog",
      });
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    await waitFor(() => {
      expect(latest?.status).toBe("error");
      expect(latest?.error).toBeInstanceOf(Error);
    });

    expect(db.rememberedRows.get("alex:myDog")).toBeUndefined();
    await app.unmount();
  });

  it("dedupes identical live queries across consumers and updates on polling", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: dogRef(),
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };

    function Probe() {
      const result = useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
      return <div>{(result.rows ?? []).map((row) => row.fields.label).join(",")}</div>;
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

  it("refreshes live queries immediately after a local core mutation", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: dogRef(),
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };

    function Probe() {
      const result = useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
      return <div>{(result.rows ?? []).map((row) => row.fields.label).join(",")}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(db.queryCalls).toBe(1);
    db.queryRows = [makeTagRow("tag_1", "friendly"), makeTagRow("tag_2", "sleepy")];

    await act(async () => {
      db.emitLocalMutation();
      await flushMicrotasks();
    });

    expect(db.queryCalls).toBe(2);
    expect(app.container.textContent).toContain("friendly,sleepy");
    await app.unmount();
  });

  it("supports live anonymous queries with anonymous projections", async () => {
    const db = new FakeDb();
    db.queryRows = [makeProjectedTagRow("tag_1", 1), makeProjectedTagRow("tag_2", 2)];

    function Probe() {
      const result = useQuery(db as unknown as Vennbase<TestSchema>, "tags", {
        in: dogRef(),
        select: "anonymous",
        orderBy: "createdAt",
        order: "asc",
      });
      return <div>{(result.rows ?? []).map((row) => `${row.id}:${row.keyFields.createdAt}`).join(",")}</div>;
    }

    const app = await renderApp(<Probe />);
    expect(app.container.textContent).toContain("tag_1:1,tag_2:2");

    db.queryRows = [makeProjectedTagRow("tag_1", 1), makeProjectedTagRow("tag_2", 2), makeProjectedTagRow("tag_3", 3)];
    await act(async () => {
      db.emitLocalMutation();
      await flushMicrotasks();
    });

    expect(app.container.textContent).toContain("tag_1:1,tag_2:2,tag_3:3");
    await app.unmount();
  });

  it("uses loading only for an initial live query without data", async () => {
    const db = new FakeDb();
    const initialQuery = deferred<typeof db.queryRows>();
    db.nextQueryPromise = initialQuery.promise;
    const queryOptions = {
      in: dogRef(),
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let latest: ReturnType<typeof useQuery<TestSchema, "tags">> | null = null;

    function Probe() {
      latest = useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("loading");
    expect(latest?.rows).toBeUndefined();
    expect(latest?.isRefreshing).toBe(false);
    expect(latest?.refreshError).toBeUndefined();

    await act(async () => {
      initialQuery.resolve([makeTagRow("tag_1", "friendly"), makeTagRow("tag_2", "sleepy")]);
      await flushMicrotasks();
    });

    expect(latest?.status).toBe("success");
    expect(latest?.rows?.map((row) => row.fields.label)).toEqual(["friendly", "sleepy"]);
    expect(latest?.isRefreshing).toBe(false);
    expect(latest?.refreshError).toBeUndefined();
    await app.unmount();
  });

  it("keeps live query status successful while polling with stale data", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: dogRef(),
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let latest: ReturnType<typeof useQuery<TestSchema, "tags">> | null = null;
    const refreshQuery = deferred<typeof db.queryRows>();

    function Probe() {
      latest = useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
      return <div>{(latest.rows ?? []).map((row) => row.fields.label).join(",")}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("success");
    expect(latest?.isRefreshing).toBe(false);

    db.nextQueryPromise = refreshQuery.promise;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(latest?.status).toBe("success");
    expect(latest?.rows?.map((row) => row.fields.label)).toEqual(["friendly"]);
    expect(latest?.isRefreshing).toBe(true);
    expect(latest?.refreshError).toBeUndefined();

    await act(async () => {
      refreshQuery.resolve([makeTagRow("tag_1", "friendly"), makeTagRow("tag_2", "sleepy")]);
      await flushMicrotasks();
    });

    expect(latest?.status).toBe("success");
    expect(latest?.rows?.map((row) => row.fields.label)).toEqual(["friendly", "sleepy"]);
    expect(latest?.isRefreshing).toBe(false);
    expect(latest?.refreshError).toBeUndefined();
    await app.unmount();
  });

  it("keeps stale live query data visible when a background refresh fails", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: dogRef(),
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let latest: ReturnType<typeof useQuery<TestSchema, "tags">> | null = null;

    function Probe() {
      latest = useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
      return <div>{(latest.rows ?? []).map((row) => row.fields.label).join(",")}</div>;
    }

    const app = await renderApp(<Probe />);

    db.nextQueryError = new Error("query refresh failed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(latest?.status).toBe("success");
    expect(latest?.rows?.map((row) => row.fields.label)).toEqual(["friendly"]);
    expect(latest?.error).toBeUndefined();
    expect(latest?.refreshError).toBeInstanceOf(Error);
    expect(latest?.isRefreshing).toBe(false);
    await app.unmount();
  });

  it("surfaces an initial live query failure as a blocking error", async () => {
    const db = new FakeDb();
    db.nextQueryError = new Error("query failed");
    const queryOptions = {
      in: dogRef(),
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let latest: ReturnType<typeof useQuery<TestSchema, "tags">> | null = null;

    function Probe() {
      latest = useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("error");
    expect(latest?.rows).toBeUndefined();
    expect(latest?.error).toBeInstanceOf(Error);
    expect(latest?.refreshError).toBeUndefined();
    expect(latest?.isRefreshing).toBe(false);
    await app.unmount();
  });

  it("accepts a row ref in live query options", async () => {
    const db = new FakeDb();
    const boardHandle = makeDogRow("Rex");
    let latest: ReturnType<typeof useQuery<TestSchema, "tags">> | null = null;

    function Probe() {
      latest = useQuery(db as unknown as Vennbase<TestSchema>, "tags", {
        in: boardHandle.ref,
        orderBy: "createdAt",
        order: "asc",
      });
      return <div>{(latest.rows ?? []).map((row) => row.fields.label).join(",")}</div>;
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
    const rowRef = dogRef();
    let latest: ReturnType<typeof useRow<TestSchema, "dogs">> | null = null;

    function Probe() {
      latest = useRow(db as unknown as Vennbase<TestSchema>, rowRef);
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

  it("shares the same row handle across identical useRow subscriptions", async () => {
    const db = new FakeDb();
    let first: ReturnType<typeof makeDogRow> | undefined;
    let second: ReturnType<typeof makeDogRow> | undefined;

    function Probe() {
      first = useRow<TestSchema, "dogs">(db as unknown as Vennbase<TestSchema>, dogRef()).data;
      second = useRow<TestSchema, "dogs">(db as unknown as Vennbase<TestSchema>, dogRef()).data;
      return null;
    }

    const app = await renderApp(<Probe />);

    expect(first).toBeDefined();
    expect(second).toBe(first);
    await app.unmount();
  });

  it("keeps a row handle stable across polls, including field updates", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    let latest: ReturnType<typeof useRow<TestSchema, "dogs">> | null = null;

    function Probe() {
      latest = useRow<TestSchema, "dogs">(db as unknown as Vennbase<TestSchema>, dogRef());
      return <div>{latest.data?.fields.name ?? latest.status}</div>;
    }

    const app = await renderApp(<Probe />);
    const initialHandle = latest?.data;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(latest?.data).toBe(initialHandle);

    db.dogName = "Max";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(latest?.data).toBe(initialHandle);
    expect(latest?.data?.fields.name).toBe("Max");
    await app.unmount();
  });

  it("does not rerun row-keyed effects when polls refresh the same logical row", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    let connectCount = 0;
    let disconnectCount = 0;

    function Probe() {
      const row = useRow<TestSchema, "dogs">(db as unknown as Vennbase<TestSchema>, dogRef()).data;

      useEffect(() => {
        if (!row) {
          return;
        }

        connectCount += 1;
        return () => {
          disconnectCount += 1;
        };
      }, [row]);

      return <div>{row?.fields.name ?? "loading"}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(connectCount).toBe(1);
    expect(disconnectCount).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(connectCount).toBe(1);
    expect(disconnectCount).toBe(0);

    db.dogName = "Max";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(connectCount).toBe(1);
    expect(disconnectCount).toBe(0);

    await app.unmount();

    expect(disconnectCount).toBe(1);
  });

  it("reruns field-keyed effects when polls replace the field snapshot", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    let effectRuns = 0;

    function Probe() {
      const row = useRow<TestSchema, "dogs">(db as unknown as Vennbase<TestSchema>, dogRef()).data;

      useEffect(() => {
        if (!row) {
          return;
        }

        effectRuns += 1;
      }, [row?.fields]);

      return <div>{row?.fields.name ?? "loading"}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(effectRuns).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(effectRuns).toBe(1);

    db.dogName = "Max";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(effectRuns).toBe(2);
    await app.unmount();
  });

  it("rerenders only for refresh-state transitions when a live query snapshot is unchanged", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: {
        id: "dog_1",
        collection: "dogs",
        baseUrl: "https://worker.example",
      },
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let renderCount = 0;

    function Probe() {
      renderCount += 1;
      useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
      return null;
    }

    const app = await renderApp(<Probe />);
    const settledCount = renderCount;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(renderCount).toBe(settledCount + 2);
    await app.unmount();
  });

  it("stays idle when a required input is missing", async () => {
    const db = new FakeDb();
    let latest: ReturnType<typeof useRow<TestSchema, "dogs">> | null = null;

    function Probe() {
      latest = useRow<TestSchema, "dogs">(db as unknown as Vennbase<TestSchema>, null);
      return <div>{latest.status}</div>;
    }

    const app = await renderApp(<Probe />);

    expect(latest?.status).toBe("idle");
    expect(db.getRowCalls).toBe(0);
    await app.unmount();
  });

  it("cleans up live polling when consumers unmount", async () => {
    vi.useFakeTimers();
    const db = new FakeDb();
    const queryOptions = {
      in: {
        id: "dog_1",
        collection: "dogs",
        baseUrl: "https://worker.example",
      },
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };

    function Probe() {
      useQuery(db as unknown as Vennbase<TestSchema>, "tags", queryOptions);
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
      in: dogRef(),
      orderBy: "createdAt" as const,
      order: "asc" as const,
      limit: 100,
    };
    let notifyActivity: (() => void) | null = null;

    function Probe() {
      const db = useVennbase<TestSchema>();
      useQuery(db, "tags", queryOptions);
      return null;
    }

    const app = await renderApp(
      <VennbaseProvider
        db={db as unknown as Vennbase<TestSchema>}
        subscribeToActivity={(notify) => {
          notifyActivity = notify;
          return () => undefined;
        }}
      >
        <Probe />
      </VennbaseProvider>,
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
