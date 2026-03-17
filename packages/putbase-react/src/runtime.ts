import type { PutBase } from "@putbase/core";
import type {
  AuthSession,
  AnyRowHandle,
  CollectionName,
  DbMemberInfo,
  DbQueryOptions,
  DbRowLocator,
  DbRowRef,
  DbSchema,
  MemberRole,
  RowFields,
  RoomUser,
} from "@putbase/core";
import type { RowHandle } from "@putbase/core";

import { createAdaptivePoller, type ActivitySubscriber, type AdaptivePoller } from "./polling";

export type LoadStatus = "idle" | "loading" | "success" | "error";

export interface ResourceSnapshot<TData> {
  data: TData | undefined;
  error: unknown;
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
  snapshotOf?: (data: TData) => string;
}

const idleSnapshot: ResourceSnapshot<never> = {
  data: undefined,
  error: undefined,
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

function snapshotRowHandle<Schema extends DbSchema>(
  row: AnyRowHandle<Schema>,
): string {
  return stableJsonStringify({
    id: row.id,
    collection: row.collection,
    owner: row.owner,
    target: row.target,
    fields: row.fields,
  });
}

function snapshotRowRefArray(value: DbRowRef[]): string {
  return stableJsonStringify(
    value.map((row) => ({
      id: row.id,
      collection: row.collection,
      owner: row.owner,
      target: row.target,
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

function snapshotRoomUser(value: RoomUser): string {
  return stableJsonStringify(value);
}

function snapshotSession(value: AuthSession): string {
  return stableJsonStringify(value);
}

function snapshotQueryRows<Schema extends DbSchema>(value: Array<AnyRowHandle<Schema>>): string {
  return stableJsonStringify(
    value.map((row) => ({
      id: row.id,
      collection: row.collection,
      owner: row.owner,
      target: row.target,
      fields: row.fields,
    })),
  );
}

class Resource<TData> implements ResourceController<TData> {
  private snapshot: ResourceSnapshot<TData> = idleSnapshot as ResourceSnapshot<TData>;
  private readonly listeners = new Set<() => void>();
  private lastValueSnapshot: string | null = null;
  private inFlight: Promise<void> | null = null;
  private poller: AdaptivePoller | null = null;

  constructor(
    private readonly options: ResourceOptions<TData>,
    private readonly onEmpty: () => void,
    private readonly subscribeToActivity?: ActivitySubscriber,
  ) {}

  getSnapshot = (): ResourceSnapshot<TData> => {
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.start();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
        this.onEmpty();
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

  private async runLoad(options: { markActivity: boolean | (() => void); isRefresh: boolean }): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    if (
      this.snapshot.status === "idle"
      || (this.snapshot.data === undefined && this.snapshot.status !== "loading")
    ) {
      this.setSnapshot({
        data: this.snapshot.data,
        error: undefined,
        status: "loading",
      });
    }

    this.inFlight = (async () => {
      try {
        const data = await this.options.load();
        const nextValueSnapshot = this.options.snapshotOf?.(data) ?? stableJsonStringify(data);
        const changed = this.lastValueSnapshot !== nextValueSnapshot || this.snapshot.status !== "success";
        this.lastValueSnapshot = nextValueSnapshot;

        if (changed) {
          this.setSnapshot({
            data,
            error: undefined,
            status: "success",
          });
          if (typeof options.markActivity === "function") {
            options.markActivity();
          }
          return;
        }

        if (this.snapshot.status === "loading") {
          this.setSnapshot({
            data: this.snapshot.data,
            error: undefined,
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
    this.setSnapshot({
      data: this.snapshot.data,
      error,
      status: "error",
    });
  }

  private setSnapshot(next: ResourceSnapshot<TData>): void {
    if (
      this.snapshot.status === next.status &&
      this.snapshot.error === next.error &&
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

export class PutBaseReactRuntime<Schema extends DbSchema = DbSchema> {
  readonly resources = new Map<string, ResourceController<unknown>>();

  constructor(
    readonly client: PutBase<Schema>,
    readonly subscribeToActivity?: ActivitySubscriber,
  ) {}

  getLoadOnce<TData>(
    key: string,
    load: () => Promise<TData>,
    snapshotOf?: (data: TData) => string,
  ): ResourceController<TData> {
    return this.getResource(key, { live: false, load, snapshotOf });
  }

  getLive<TData>(
    key: string,
    load: () => Promise<TData>,
    snapshotOf?: (data: TData) => string,
  ): ResourceController<TData> {
    return this.getResource(key, { live: true, load, snapshotOf });
  }

  private getResource<TData>(key: string, options: ResourceOptions<TData>): ResourceController<TData> {
    const existing = this.resources.get(key);
    if (existing) {
      return existing as ResourceController<TData>;
    }

    const resource = new Resource<TData>(
      options,
      () => {
        this.resources.delete(key);
      },
      this.subscribeToActivity,
    );
    this.resources.set(key, resource as ResourceController<unknown>);
    return resource;
  }
}

const defaultRuntimes = new WeakMap<object, PutBaseReactRuntime<any>>();

export function getDefaultRuntime<Schema extends DbSchema>(
  client: PutBase<Schema>,
): PutBaseReactRuntime<Schema> {
  const existing = defaultRuntimes.get(client as object);
  if (existing) {
    return existing as PutBaseReactRuntime<Schema>;
  }

  const runtime = new PutBaseReactRuntime(client);
  defaultRuntimes.set(client as object, runtime);
  return runtime;
}

export function getIdleSnapshot<TData>(): ResourceSnapshot<TData> {
  return idleSnapshot as ResourceSnapshot<TData>;
}

export function makeQueryKey<Schema extends DbSchema, TCollection extends CollectionName<Schema>>(
  collection: TCollection,
  options: DbQueryOptions<Schema, TCollection>,
): string {
  return `query:${collection}:${stableJsonStringify(options)}`;
}

export function makeRowKey<TCollection extends string>(
  collection: TCollection,
  row: DbRowRef<TCollection>,
): string {
  return `row:${collection}:${stableJsonStringify(row)}`;
}

export function makeRowTargetKey(target: string): string {
  return `row-target:${target}`;
}

export function makeParentsKey(row: DbRowLocator): string {
  return `parents:${stableJsonStringify(row)}`;
}

export function makeMembersKey(kind: "usernames" | "direct" | "effective", row: DbRowLocator): string {
  return `${kind}:${stableJsonStringify(row)}`;
}

export function makeInviteLinkKey(row: Pick<DbRowLocator, "target">): string {
  return `invite-link:${row.target}`;
}

export const snapshots = {
  queryRows: snapshotQueryRows,
  row: snapshotRowHandle,
  rowRefs: snapshotRowRefArray,
  memberUsernames: snapshotStrings,
  directMembers: snapshotMembers,
  effectiveMembers: snapshotEffectiveMembers,
  currentUser: snapshotRoomUser,
  session: snapshotSession,
};

export type QueryRows<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> = Array<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>>;
