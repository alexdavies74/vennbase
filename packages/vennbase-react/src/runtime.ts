import type { Vennbase } from "@vennbase/core";
import {
  isRowRef,
  toRowRef,
  type AuthSession,
  type CollectionName,
  type DbMemberInfo,
  type DbQueryOptions,
  type DbQueryRows,
  type DbQuerySelect,
  type DbSchema,
  type InferDbQuerySelect,
  type MemberRole,
  type VennbaseUser,
  type RowRef,
  type RowInput,
} from "@vennbase/core";
import { createAdaptivePoller, subscribeToBrowserActivity, type ActivitySubscriber, type AdaptivePoller } from "./polling.js";

type MutationSubscribedClient<Schema extends DbSchema> = Vennbase<Schema> & {
  subscribeToLocalMutations?: (listener: () => void) => (() => void) | void;
};

const browserActivitySubscriber: ActivitySubscriber = (notify) => {
  return subscribeToBrowserActivity(notify) ?? undefined;
};

function composeActivitySubscribers(...subscribers: Array<ActivitySubscriber | undefined>): ActivitySubscriber | undefined {
  const activeSubscribers = subscribers.filter((subscriber): subscriber is ActivitySubscriber => !!subscriber);
  if (activeSubscribers.length === 0) {
    return undefined;
  }

  return (notify) => {
    const unsubscribers = activeSubscribers
      .map((subscriber) => subscriber(notify))
      .filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  };
}

export type LoadStatus = "idle" | "loading" | "success" | "error";

export interface ResourceSnapshot<TData> {
  data: TData | undefined;
  error: unknown;
  refreshError: unknown;
  isRefreshing: boolean;
  status: LoadStatus;
}

export interface ResourceController<TData> {
  getSnapshot(): ResourceSnapshot<TData>;
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

interface ResourceOptions<TData> {
  load: () => Promise<TData>;
  live: boolean;
  localMutationBehavior: "live" | "refresh" | "ignore";
  snapshotOf?: (data: TData) => string;
  peek?: () => TData;
}

const idleSnapshot: ResourceSnapshot<never> = {
  data: undefined,
  error: undefined,
  refreshError: undefined,
  isRefreshing: false,
  status: "idle",
};

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function snapshotValue(value: unknown): string {
  return stableJsonStringify(canonicalizeKeyPart(value));
}

function isRowInputLike(value: unknown): value is RowInput {
  if (isRowRef(value)) {
    return true;
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return isRowRef(record.ref);
}

function canonicalizeRowRef(value: RowRef): Record<string, string> {
  return {
    id: value.id,
    collection: value.collection,
    baseUrl: value.baseUrl,
  };
}

function canonicalizeKeyPart(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (isRowInputLike(value)) {
    return canonicalizeRowRef(toRowRef(value));
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeKeyPart(entry, seen));
  }

  const record = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "undefined") {
      continue;
    }
    canonical[key] = canonicalizeKeyPart(entry, seen);
  }
  return canonical;
}

function snapshotRowHandle(row: {
  id: string;
  collection: string;
  owner: string;
  ref: RowRef;
  fields: unknown;
}): string {
  return stableJsonStringify({
    id: row.id,
    collection: row.collection,
    owner: row.owner,
    ref: row.ref,
    fields: row.fields,
  });
}

function snapshotRowRefArray(value: RowRef[]): string {
  return stableJsonStringify(
    value.map((row) => ({
      id: row.id,
      collection: row.collection,
      baseUrl: row.baseUrl,
    })),
  );
}

function snapshotMembers(value: Array<{ username: string; role: MemberRole }>): string {
  return stableJsonStringify(value);
}

function snapshotEffectiveMembers<Schema extends DbSchema>(
  value: Array<DbMemberInfo<Schema>>,
): string {
  return stableJsonStringify(value);
}

function snapshotStrings(value: string[]): string {
  return stableJsonStringify(value);
}

function snapshotCurrentUser(value: VennbaseUser): string {
  return stableJsonStringify(value);
}

function snapshotSession(value: AuthSession): string {
  return stableJsonStringify(value);
}

function snapshotQueryRows(value: Array<{
  id: string;
  collection: string;
  fields?: unknown;
  kind?: "index-key-projection";
  owner?: string;
  ref?: RowRef;
}>): string {
  return stableJsonStringify(
    value.map((row) => ({
      id: row.id,
      collection: row.collection,
      ...(row.kind ? { kind: row.kind } : {}),
      owner: row.owner,
      ...("ref" in row && row.ref ? { ref: row.ref } : {}),
      ...("fields" in row ? { fields: row.fields } : {}),
    })),
  );
}

class Resource<TData> implements ResourceController<TData> {
  private snapshot: ResourceSnapshot<TData> = idleSnapshot as ResourceSnapshot<TData>;
  private readonly listeners = new Set<() => void>();
  private lastValueSnapshot: string | null = null;
  private lastAppliedByPeek = false;
  private inFlight: Promise<void> | null = null;
  private poller: AdaptivePoller | null = null;
  private disposeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly live: boolean,
    readonly localMutationBehavior: ResourceOptions<TData>["localMutationBehavior"],
    private readonly options: ResourceOptions<TData>,
    private readonly onEmpty: () => void,
    private readonly subscribeToActivity?: ActivitySubscriber,
  ) {}

  getSnapshot = (): ResourceSnapshot<TData> => {
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.cancelPendingDispose();
    const wasEmpty = this.listeners.size === 0;
    this.listeners.add(listener);
    if (wasEmpty) {
      this.start();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
        this.scheduleDispose();
      }
    };
  };

  refresh = async (): Promise<void> => {
    if (this.poller) {
      await this.poller.refresh();
      return;
    }

    await this.runLoad({ markActivity: false, isRefresh: true });
  };

  applyPeek = (): void => {
    if (!this.options.peek || this.snapshot.status !== "success") {
      return;
    }

    try {
      const data = this.options.peek();
      const nextValueSnapshot = this.options.snapshotOf?.(data) ?? snapshotValue(data);
      if (this.lastValueSnapshot !== nextValueSnapshot) {
        this.lastValueSnapshot = nextValueSnapshot;
        this.lastAppliedByPeek = true;
        this.setSnapshot({
          data,
          error: undefined,
          refreshError: undefined,
          isRefreshing: true,
          status: "success",
        });
      }
    } catch {
      // ignore peek errors — the async refresh will handle failures
    }
  };

  private start(): void {
    if (this.options.live) {
      this.poller = createAdaptivePoller({
        subscribeToActivity: this.subscribeToActivity,
        onError: (error) => {
          this.fail(error);
        },
        run: async ({ markActivity }) => {
          await this.runLoad({ markActivity, isRefresh: false });
        },
      });
      return;
    }

    if (this.snapshot.status === "idle") {
      void this.runLoad({ markActivity: false, isRefresh: false });
    }
  }

  private stop(): void {
    this.poller?.disconnect();
    this.poller = null;
  }

  private scheduleDispose(): void {
    if (this.disposeTimeout) {
      return;
    }

    // React can briefly unsubscribe and resubscribe the same live resource
    // during StrictMode and external-store churn. Delay eviction so the runtime
    // map stays consistent across that transient gap.
    this.disposeTimeout = setTimeout(() => {
      this.disposeTimeout = null;
      if (this.listeners.size === 0) {
        this.onEmpty();
      }
    }, 0);
  }

  private cancelPendingDispose(): void {
    if (!this.disposeTimeout) {
      return;
    }

    clearTimeout(this.disposeTimeout);
    this.disposeTimeout = null;
  }

  private async runLoad(options: { markActivity: boolean | (() => void); isRefresh: boolean }): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    if (this.snapshot.status === "success") {
      this.setSnapshot({
        data: this.snapshot.data,
        error: undefined,
        refreshError: undefined,
        isRefreshing: true,
        status: "success",
      });
    } else if (
      this.snapshot.status === "idle"
      || (this.snapshot.data === undefined && this.snapshot.status !== "loading")
    ) {
      this.setSnapshot({
        data: this.snapshot.data,
        error: undefined,
        refreshError: undefined,
        isRefreshing: false,
        status: "loading",
      });
    }

    this.inFlight = (async () => {
      try {
        const data = await this.options.load() as TData;
        let displayData: TData = data;
        let nextValueSnapshot = this.options.snapshotOf?.(data) ?? snapshotValue(data);
        let appliedByPeek = false;

        if (this.lastAppliedByPeek && this.options.peek) {
          try {
            const peekData = this.options.peek();
            const peekSnapshot = this.options.snapshotOf?.(peekData) ?? snapshotValue(peekData);
            if (peekSnapshot !== nextValueSnapshot) {
              displayData = peekData;
              nextValueSnapshot = peekSnapshot;
              appliedByPeek = true;
            }
          } catch {
            // ignore peek errors — the loaded server snapshot is still usable
          }
        }

        const changed = this.lastValueSnapshot !== nextValueSnapshot;
        this.lastValueSnapshot = nextValueSnapshot;
        this.lastAppliedByPeek = appliedByPeek;

        if (changed) {
          this.setSnapshot({
            data: displayData,
            error: undefined,
            refreshError: undefined,
            isRefreshing: false,
            status: "success",
          });
          if (typeof options.markActivity === "function") {
            options.markActivity();
          }
          return;
        }

        if (
          this.snapshot.status !== "success"
          || this.snapshot.error !== undefined
          || this.snapshot.refreshError !== undefined
          || this.snapshot.isRefreshing
        ) {
          this.setSnapshot({
            data: this.snapshot.data,
            error: undefined,
            refreshError: undefined,
            isRefreshing: false,
            status: "success",
          });
        }
      } catch (error) {
        this.fail(error);
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  private fail(error: unknown): void {
    if (this.snapshot.status === "success") {
      this.setSnapshot({
        data: this.snapshot.data,
        error: undefined,
        refreshError: error,
        isRefreshing: false,
        status: "success",
      });
      return;
    }

    this.setSnapshot({
      data: this.snapshot.data,
      error,
      refreshError: undefined,
      isRefreshing: false,
      status: "error",
    });
  }

  private setSnapshot(next: ResourceSnapshot<TData>): void {
    if (
      this.snapshot.status === next.status &&
      this.snapshot.error === next.error &&
      this.snapshot.refreshError === next.refreshError &&
      this.snapshot.isRefreshing === next.isRefreshing &&
      this.snapshot.data === next.data
    ) {
      return;
    }

    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export class VennbaseReactRuntime<Schema extends DbSchema = DbSchema> {
  readonly resources = new Map<string, Resource<unknown>>();
  readonly externalSubscribeToActivity?: ActivitySubscriber;
  readonly subscribeToActivity?: ActivitySubscriber;
  private localMutationFlushScheduled = false;
  private localMutationFlushInFlight = false;
  private localMutationFlushPending = false;

  constructor(
    readonly client: Vennbase<Schema>,
    subscribeToActivity?: ActivitySubscriber,
  ) {
    this.externalSubscribeToActivity = subscribeToActivity;
    this.subscribeToActivity = composeActivitySubscribers(
      browserActivitySubscriber,
      subscribeToActivity,
    );
    this.subscribeToCoreMutations();
  }

  getLoadOnce<TData>(
    key: string,
    load: () => Promise<TData>,
    snapshotOf?: (data: TData) => string,
    localMutationBehavior: ResourceOptions<TData>["localMutationBehavior"] = "ignore",
  ): ResourceController<TData> {
    return this.getResource(key, {
      live: false,
      load,
      localMutationBehavior,
      snapshotOf,
    });
  }

  getLive<TData>(
    key: string,
    load: () => Promise<TData>,
    snapshotOf?: (data: TData) => string,
    peek?: () => TData,
  ): ResourceController<TData> {
    return this.getResource(key, {
      live: true,
      load,
      localMutationBehavior: "live",
      snapshotOf,
      peek,
    });
  }

  async refreshLiveResources(): Promise<void> {
    const refreshes = Array.from(this.resources.values())
      .filter((resource) => resource.live)
      .map((resource) => resource.refresh());
    await Promise.all(refreshes);
  }

  private getResource<TData>(key: string, options: ResourceOptions<TData>): ResourceController<TData> {
    const existing = this.resources.get(key);
    if (existing) {
      return existing as ResourceController<TData>;
    }

    const resource = new Resource<TData>(
      options.live,
      options.localMutationBehavior,
      options,
      () => {
        this.resources.delete(key);
      },
      this.subscribeToActivity,
    );
    this.resources.set(key, resource as Resource<unknown>);
    return resource;
  }

  private applyLocalPeeks(): void {
    for (const resource of this.resources.values()) {
      if (resource.localMutationBehavior === "live") {
        resource.applyPeek();
      }
    }
  }

  private collectLocalMutationRefreshes(): Promise<void[]> {
    this.applyLocalPeeks();
    const refreshes = Array.from(this.resources.values())
      .filter((resource) => resource.localMutationBehavior !== "ignore")
      .map((resource) => resource.refresh());
    return Promise.all(refreshes);
  }

  private scheduleLocalMutationFlush(): void {
    if (this.localMutationFlushInFlight) {
      this.localMutationFlushPending = true;
      return;
    }

    if (this.localMutationFlushScheduled) {
      return;
    }

    this.localMutationFlushScheduled = true;
    queueMicrotask(() => {
      this.localMutationFlushScheduled = false;
      void this.flushLocalMutations();
    });
  }

  private async flushLocalMutations(): Promise<void> {
    if (this.localMutationFlushInFlight) {
      this.localMutationFlushPending = true;
      return;
    }

    this.localMutationFlushInFlight = true;
    try {
      await this.collectLocalMutationRefreshes();
    } finally {
      this.localMutationFlushInFlight = false;
      if (this.localMutationFlushPending) {
        this.localMutationFlushPending = false;
        this.scheduleLocalMutationFlush();
      }
    }
  }

  private subscribeToCoreMutations(): void {
    const client = this.client as MutationSubscribedClient<Schema>;
    if (typeof client.subscribeToLocalMutations !== "function") {
      return;
    }

    client.subscribeToLocalMutations?.(() => {
      this.scheduleLocalMutationFlush();
    });
  }
}

const defaultRuntimes = new WeakMap<object, VennbaseReactRuntime<any>>();

export function getDefaultRuntime<Schema extends DbSchema>(
  client: Vennbase<Schema>,
): VennbaseReactRuntime<Schema> {
  const existing = defaultRuntimes.get(client as object);
  if (existing) {
    return existing as VennbaseReactRuntime<Schema>;
  }

  const runtime = new VennbaseReactRuntime(client);
  defaultRuntimes.set(client as object, runtime);
  return runtime;
}

export function getIdleSnapshot<TData>(): ResourceSnapshot<TData> {
  return idleSnapshot as ResourceSnapshot<TData>;
}

export function makeQueryKey<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
  TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
>(
  collection: TCollection,
  options: TOptions,
): string {
  return `query:${collection}:${stableJsonStringify(canonicalizeKeyPart(options))}`;
}

export function makeRowKey<TCollection extends string>(
  collection: TCollection,
  row: RowInput<TCollection>,
): string {
  return `row:${collection}:${stableJsonStringify(canonicalizeKeyPart(row))}`;
}

export function makeParentsKey(row: RowInput): string {
  return `parents:${stableJsonStringify(canonicalizeKeyPart(row))}`;
}

export function makeMembersKey(kind: "usernames" | "direct" | "effective", row: RowInput): string {
  return `${kind}:${stableJsonStringify(canonicalizeKeyPart(row))}`;
}

export function makeShareLinkKey(row: RowInput, role: MemberRole): string {
  return `share-link:${stableJsonStringify(canonicalizeKeyPart({ row, role }))}`;
}

export function makeIncomingInviteKey(inviteInput: string): string {
  return `incoming-invite:${inviteInput}`;
}

export function makeSavedRowKey(username: string, rowKey: string): string {
  return `saved-row:${username}:${rowKey}`;
}

export const snapshots = {
  queryRows: snapshotQueryRows,
  row: snapshotRowHandle,
  rowRefs: snapshotRowRefArray,
  memberUsernames: snapshotStrings,
  directMembers: snapshotMembers,
  effectiveMembers: snapshotEffectiveMembers,
  currentUser: snapshotCurrentUser,
  session: snapshotSession,
};

export type QueryRows<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
  TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
> = DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>;
