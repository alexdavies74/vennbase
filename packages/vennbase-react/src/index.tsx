import { SavedRowCollectionMismatchError, VENNBASE_INVITE_TARGET_PARAM, isRowRef, toRowRef } from "@vennbase/core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Vennbase } from "@vennbase/core";
import type {
  AuthSession,
  AnyRowHandle,
  CollectionName,
  CrdtAdapter,
  CrdtConnectCallbacks,
  CrdtConnection,
  DbMemberInfo,
  DbQueryOptions,
  DbQueryRows,
  DbQuerySelect,
  DbQueryRow,
  DbSchema,
  InferDbQuerySelect,
  MemberRole,
  VennbaseUser,
  RowRef,
  RowInput,
} from "@vennbase/core";
import type { RowHandle } from "@vennbase/core";

import type { ActivitySubscriber } from "./polling.js";
import {
  getDefaultRuntime,
  getIdleSnapshot,
  makeShareLinkKey,
  makeIncomingInviteKey,
  makeMembersKey,
  makeSavedRowKey,
  makeParentsKey,
  makeQueryKey,
  makeRowKey,
  type LoadStatus,
  type VennbaseReactRuntime,
  type QueryRows,
  type ResourceController,
  type ResourceSnapshot,
  snapshots,
} from "./runtime.js";
import { VennbaseReactRuntime as Runtime } from "./runtime.js";

export type { ActivitySubscriber } from "./polling.js";
export type { LoadStatus } from "./runtime.js";

export interface UseResourceResult<TData> extends ResourceSnapshot<TData> {
  isIdle: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  refresh(): Promise<void>;
}

export interface UseQueryResult<TRow> extends UseResourceResult<TRow[]> {
  rows: TRow[] | undefined;
}

export type UseShareLinkResult = Omit<UseResourceResult<string>, "data"> & {
  shareLink: string | undefined;
};

export interface UseSessionResult extends UseResourceResult<AuthSession> {
  session: AuthSession | undefined;
  signIn(): Promise<VennbaseUser>;
}

export interface UseCurrentUserResult extends UseResourceResult<VennbaseUser> {
  user: VennbaseUser | undefined;
}

export interface UseRowResult<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
> extends UseResourceResult<RowHandle<Schema, TCollection>> {
  row: RowHandle<Schema, TCollection> | undefined;
}

export interface UseCrdtResult<TValue> {
  value: TValue;
  version: number;
  status: "idle" | "connected";
  flush(): Promise<void>;
}

export interface UseHookOptions {
  enabled?: boolean;
}

export interface UseShareLinkHookOptions extends UseHookOptions {}

export interface OpenedInviteResult<
  Schema extends DbSchema,
  TOpened extends AnyRowHandle<Schema> = AnyRowHandle<Schema>,
> {
  kind: "opened";
  ref: RowRef;
  role: Exclude<MemberRole, "submitter">;
  row: TOpened;
}

export interface JoinedInviteResult {
  kind: "joined";
  ref: RowRef;
  role: "submitter";
}

export type AcceptedInviteResult<
  Schema extends DbSchema,
  TOpened extends AnyRowHandle<Schema> = AnyRowHandle<Schema>,
> =
  | OpenedInviteResult<Schema, TOpened>
  | JoinedInviteResult;

export interface UseAcceptInviteFromUrlOptions<
  Schema extends DbSchema,
  TOpened extends AnyRowHandle<Schema> = AnyRowHandle<Schema>,
> extends UseHookOptions {
  url?: string | null;
  clearInviteParams?: boolean | ((url: URL) => string);
  onOpen?: (row: TOpened) => void | Promise<void>;
  onResolve?: (result: AcceptedInviteResult<Schema, TOpened>) => void | Promise<void>;
}

export interface UseAcceptInviteFromUrlResult<
  Schema extends DbSchema,
  TOpened extends AnyRowHandle<Schema> = AnyRowHandle<Schema>,
> extends UseResourceResult<AcceptedInviteResult<Schema, TOpened>> {
  hasInvite: boolean;
  inviteInput: string | null;
}

export interface UseSavedRowOptions<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
  TResult = RowHandle<Schema, TCollection>,
> extends UseHookOptions {
  key: string;
  collection: TCollection;
  loadSavedRow?: (row: RowHandle<Schema, NoInfer<TCollection>>, db: Vennbase<Schema>) => Promise<TResult> | TResult;
  getRow?: (result: TResult) => RowInput<NoInfer<TCollection>>;
}

export interface UseSavedRowResult<TResult> extends UseResourceResult<TResult | null> {
  row: TResult | null | undefined;
  save(result: TResult): Promise<void>;
  clear(): Promise<void>;
}

export interface VennbaseProviderProps<Schema extends DbSchema> {
  children: ReactNode;
  db: Vennbase<Schema>;
  subscribeToActivity?: ActivitySubscriber;
  client?: never;
}

const RuntimeContext = createContext<VennbaseReactRuntime<any> | null>(null);

const noopSubscribe = () => () => undefined;
const noopRefresh = async () => undefined;
const noopFlush = async () => undefined;

interface CrdtRowLike {
  ref: RowRef;
  connectCrdt(callbacks: CrdtConnectCallbacks): CrdtConnection;
}

function getLoadState(status: LoadStatus): Pick<UseResourceResult<never>, "isIdle" | "isLoading" | "isSuccess" | "isError"> {
  return {
    isIdle: status === "idle",
    isLoading: status === "loading",
    isSuccess: status === "success",
    isError: status === "error",
  };
}

function makeResourceResult<TData>(
  snapshot: Partial<ResourceSnapshot<TData>> & Pick<ResourceSnapshot<TData>, "status">,
  refresh: () => Promise<void> = noopRefresh,
): UseResourceResult<TData> {
  return {
    data: snapshot.data,
    error: snapshot.error,
    refreshError: snapshot.refreshError,
    isRefreshing: snapshot.isRefreshing ?? false,
    ...getLoadState(snapshot.status),
    status: snapshot.status,
    refresh,
  };
}

function useRuntime<Schema extends DbSchema>(db?: Vennbase<Schema>): VennbaseReactRuntime<Schema> {
  const contextRuntime = useContext(RuntimeContext);
  if (db) {
    if (contextRuntime && contextRuntime.client === db) {
      return contextRuntime as VennbaseReactRuntime<Schema>;
    }

    return getDefaultRuntime(db);
  }

  if (!contextRuntime) {
    throw new Error("VennbaseProvider is missing.");
  }

  return contextRuntime as VennbaseReactRuntime<Schema>;
}

function useResource<TData>(
  resource: ResourceController<TData> | null,
): UseResourceResult<TData> {
  const snapshot = useSyncExternalStore(
    resource ? resource.subscribe : noopSubscribe,
    resource ? resource.getSnapshot : () => getIdleSnapshot<TData>(),
    () => getIdleSnapshot<TData>(),
  );

  return {
    ...snapshot,
    ...getLoadState(snapshot.status),
    refresh: resource ? resource.refresh : noopRefresh,
  };
}

function useOptionalResource<TData>(
  enabled: boolean,
  resourceKey: string | null,
  resourceOwner: object,
  resolve: () => ResourceController<TData>,
): UseResourceResult<TData> {
  const resource = useMemo(
    () => (enabled ? resolve() : null),
    [enabled, resourceKey, resourceOwner],
  );
  return useResource(resource);
}

function useSessionResource<Schema extends DbSchema>(
  runtime: VennbaseReactRuntime<Schema>,
  enabled: boolean,
): UseResourceResult<AuthSession> {
  return useOptionalResource(
    enabled,
    "session",
    runtime,
    () => runtime.getLoadOnce("session", () => runtime.client.getSession(), snapshots.session, "refresh"),
  );
}

function blockedResourceResult<TData>(
  session: UseResourceResult<AuthSession>,
): UseResourceResult<TData> | null {
  if (session.status === "error") {
    return makeResourceResult<TData>({
      error: session.error,
      status: "error",
    }, session.refresh);
  }

  if (session.status !== "success" || !session.data?.signedIn) {
    return makeResourceResult<TData>({
      status: "idle",
    }, session.refresh);
  }

  return null;
}

function getInviteInputFromUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.has(VENNBASE_INVITE_TARGET_PARAM)) {
    return url.toString();
  }

  return null;
}

function clearInviteUrl(
  clearInviteParams: boolean | ((url: URL) => string),
  inviteInput: string,
): void {
  if (typeof window === "undefined") {
    return;
  }

  const current = new URL(window.location.href);
  if (current.toString() !== inviteInput) {
    return;
  }

  if (typeof clearInviteParams === "function") {
    window.history.replaceState({}, "", clearInviteParams(current));
    return;
  }

  current.search = "";
  window.history.replaceState({}, "", `${current.pathname}${current.hash}`);
}

function hasRowRef(value: unknown): value is { ref: RowRef } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { ref?: unknown };
  return !!candidate.ref
    && typeof candidate.ref === "object"
    && typeof (candidate.ref as { id?: unknown }).id === "string"
    && typeof (candidate.ref as { collection?: unknown }).collection === "string"
    && typeof (candidate.ref as { baseUrl?: unknown }).baseUrl === "string";
}

function getRowFromResult<TResult, TCollection extends string>(
  result: TResult,
  getRow?: (result: TResult) => RowInput<TCollection>,
): RowInput<TCollection> {
  const row = getRow
    ? getRow(result)
    : isRowRef(result)
      ? result as RowInput<TCollection>
      : hasRowRef(result)
      ? result.ref as RowInput<TCollection>
      : null;
  if (!row) {
    throw new Error("useSavedRow could not resolve a row. Pass getRow when returning non-row data.");
  }
  return row;
}

async function resolveInviteFromUrl<
  Schema extends DbSchema,
  TOpened extends AnyRowHandle<Schema> = AnyRowHandle<Schema>,
>(
  inviteInput: string,
  db: Vennbase<Schema>,
): Promise<AcceptedInviteResult<Schema, TOpened>> {
  const joined = await db.joinInvite(inviteInput);
  if (joined.role === "submitter") {
    return {
      kind: "joined",
      ref: joined.ref,
      role: joined.role,
    };
  }

  const row = await db.getRow(joined.ref as RowRef<CollectionName<Schema>>) as TOpened;
  return {
    kind: "opened",
    ref: joined.ref,
    role: joined.role,
    row,
  };
}

export function VennbaseProvider<Schema extends DbSchema>({
  children,
  db,
  subscribeToActivity,
}: VennbaseProviderProps<Schema>) {
  const runtimeRef = useRef<VennbaseReactRuntime<Schema> | null>(null);
  if (
    runtimeRef.current === null ||
    runtimeRef.current.client !== db ||
    runtimeRef.current.externalSubscribeToActivity !== subscribeToActivity
  ) {
    runtimeRef.current = subscribeToActivity
      ? new Runtime(db, subscribeToActivity)
      : getDefaultRuntime(db);
  }

  return (
    <RuntimeContext.Provider value={runtimeRef.current}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useVennbase<Schema extends DbSchema>(): Vennbase<Schema> {
  return useRuntime<Schema>().client;
}

export function useCrdt<TValue>(
  row: CrdtRowLike | null | undefined,
  adapter: CrdtAdapter<TValue>,
): UseCrdtResult<TValue> {
  const connectionRef = useRef<CrdtConnection | null>(null);
  const rowKeyRef = useRef<string | null>(null);
  const snapshotRef = useRef<{ value: TValue; version: number } | null>(null);
  const getSnapshot = () => {
    const nextValue = adapter.getValue();
    const nextVersion = adapter.getVersion();
    const cached = snapshotRef.current;
    if (cached && cached.version === nextVersion && cached.value === nextValue) {
      return cached;
    }

    const nextSnapshot = {
      value: nextValue,
      version: nextVersion,
    };
    snapshotRef.current = nextSnapshot;
    return nextSnapshot;
  };
  const snapshot = useSyncExternalStore(
    adapter.subscribe,
    getSnapshot,
    getSnapshot,
  );

  useEffect(() => {
    if (!row) {
      if (rowKeyRef.current !== null) {
        adapter.reset();
        rowKeyRef.current = null;
      }
      connectionRef.current = null;
      return;
    }

    const nextRowKey = `${row.ref.baseUrl}:${row.ref.id}`;
    if (rowKeyRef.current !== null && rowKeyRef.current !== nextRowKey) {
      adapter.reset();
    }

    const connection = row.connectCrdt(adapter.callbacks);
    connectionRef.current = connection;
    rowKeyRef.current = nextRowKey;

    return () => {
      connection.disconnect();
      if (connectionRef.current === connection) {
        connectionRef.current = null;
      }
    };
  }, [adapter, row]);

  return {
    ...snapshot,
    status: row ? "connected" : "idle",
    async flush(): Promise<void> {
      if (!connectionRef.current) {
        await noopFlush();
        return;
      }
      await connectionRef.current.flush();
    },
  };
}

export function useSession<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  options: UseHookOptions = {},
): UseSessionResult {
  const runtime = useRuntime(db);
  const resource = useSessionResource(runtime, options.enabled ?? true);
  return {
    ...resource,
    session: resource.status === "success" ? resource.data : undefined,
    async signIn(): Promise<VennbaseUser> {
      const user = await runtime.client.signIn();
      await resource.refresh();
      return user;
    },
  };
}

export function useCurrentUser<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  options: UseHookOptions = {},
): UseCurrentUserResult {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const result = session.status === "error"
    ? makeResourceResult<VennbaseUser>({
        error: session.error,
        status: "error",
      }, session.refresh)
    : session.status !== "success" || !session.data?.signedIn
      ? makeResourceResult<VennbaseUser>({
          status: "idle",
        }, session.refresh)
      : makeResourceResult<VennbaseUser>({
          data: session.data.user,
          status: "success",
        }, session.refresh);

  return {
    ...result,
    user: result.data,
  };
}

export function useQuery<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
  TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
>(
  db: Vennbase<Schema>,
  collection: TCollection,
  options: TOptions | null | undefined,
  hookOptions: UseHookOptions = {},
): UseQueryResult<DbQueryRow<Schema, TCollection, InferDbQuerySelect<TOptions>>> {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, hookOptions.enabled ?? true);
  const resourceKey = options ? makeQueryKey<Schema, TCollection, TOptions>(collection, options) : null;
  const blocked = blockedResourceResult<DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>>(session);
  const isFullQuery = options?.select !== "indexKeys";
  const resource = useOptionalResource(
    (hookOptions.enabled ?? true) && !!options && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.query(
        collection,
        options as TOptions,
      ),
      snapshots.queryRows,
      isFullQuery
        ? () => runtime.client.peekQuery(
            collection,
            options as DbQueryOptions<Schema, TCollection, "full">,
          ) as DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>
        : undefined,
    ),
  );

  const result = blocked ?? resource;

  return {
    ...result,
    rows: result.data,
  };
}

export function useRow<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  db: Vennbase<Schema>,
  row: RowInput<TCollection> | null | undefined,
  options: UseHookOptions = {},
): UseRowResult<Schema, TCollection> {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? toRowRef(row) : null;
  const resourceKey = rowRef ? makeRowKey(rowRef.collection, rowRef) : null;
  const blocked = blockedResourceResult<RowHandle<Schema, TCollection>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!rowRef && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.getRow(
        rowRef as RowRef<TCollection>,
      ) as Promise<RowHandle<Schema, TCollection>>,
      snapshots.row,
    ),
  );

  const result = blocked ?? resource;

  return {
    ...result,
    row: result.data,
  };
}

export function useParents<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<RowRef>> {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? toRowRef(row) : null;
  const resourceKey = rowRef ? makeParentsKey(rowRef) : null;
  const blocked = blockedResourceResult<Array<RowRef>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!rowRef && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.listParents(rowRef as RowRef),
      snapshots.rowRefs,
    ),
  );
  return blocked ?? resource;
}

export function useMemberUsernames<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<string[]> {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? toRowRef(row) : null;
  const resourceKey = rowRef ? makeMembersKey("usernames", rowRef) : null;
  const blocked = blockedResourceResult<string[]>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!rowRef && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.listMembers(rowRef as RowRef),
      snapshots.memberUsernames,
    ),
  );
  return blocked ?? resource;
}

export function useDirectMembers<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<{ username: string; role: MemberRole }>> {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? toRowRef(row) : null;
  const resourceKey = rowRef ? makeMembersKey("direct", rowRef) : null;
  const blocked = blockedResourceResult<Array<{ username: string; role: MemberRole }>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!rowRef && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.listDirectMembers(rowRef as RowRef),
      snapshots.directMembers,
    ),
  );
  return blocked ?? resource;
}

export function useEffectiveMembers<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<DbMemberInfo<Schema>>> {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? toRowRef(row) : null;
  const resourceKey = rowRef ? makeMembersKey("effective", rowRef) : null;
  const blocked = blockedResourceResult<Array<DbMemberInfo<Schema>>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!rowRef && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.listEffectiveMembers(rowRef as RowRef),
      snapshots.effectiveMembers,
    ),
  );
  return blocked ?? resource;
}

export function useShareLink<Schema extends DbSchema>(
  db: Vennbase<Schema>,
  row: RowInput | null | undefined,
  role: MemberRole,
  options: UseShareLinkHookOptions = {},
): UseShareLinkResult {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? toRowRef(row) : null;
  const resourceKey = rowRef ? makeShareLinkKey(rowRef, role) : null;
  const blocked = blockedResourceResult<string>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!rowRef && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLoadOnce(
      resourceKey as string,
      async () => {
        const existing = await runtime.client.getExistingShareToken(rowRef as RowRef, role);
        const shareToken = existing ?? runtime.client.createShareToken(rowRef as RowRef, role).value;
        return runtime.client.createShareLink(rowRef as RowRef, shareToken);
      },
      undefined,
      "refresh",
    ),
  );
  const result = blocked ?? resource;

  return {
    shareLink: result.data,
    error: result.error,
    refreshError: result.refreshError,
    isIdle: result.isIdle,
    isLoading: result.isLoading,
    isSuccess: result.isSuccess,
    isError: result.isError,
    isRefreshing: result.isRefreshing,
    status: result.status,
    refresh: result.refresh,
  };
}

export function useAcceptInviteFromUrl<
  Schema extends DbSchema,
  TOpened extends AnyRowHandle<Schema> = AnyRowHandle<Schema>,
>(
  db: Vennbase<Schema>,
  options: UseAcceptInviteFromUrlOptions<Schema, TOpened> = {},
): UseAcceptInviteFromUrlResult<Schema, TOpened> {
  const runtime = useRuntime(db);
  const enabled = options.enabled ?? true;
  const session = useSessionResource(runtime, enabled);
  const detectedInviteInput = options.url ?? getInviteInputFromUrl();
  const [latchedInviteInput, setLatchedInviteInput] = useState<string | null>(detectedInviteInput);
  const inviteInput = detectedInviteInput ?? latchedInviteInput;
  const resourceKey = inviteInput ? makeIncomingInviteKey(inviteInput) : null;
  const clearInviteParamsOption = options.clearInviteParams ?? true;
  const deliveryKey = inviteInput ?? null;
  const onOpenRef = useRef(options.onOpen);
  const onResolveRef = useRef(options.onResolve);
  const clearInviteParamsRef = useRef(clearInviteParamsOption);
  const [deliveryEpoch, setDeliveryEpoch] = useState(0);
  const currentDeliveryKey = deliveryKey ? `${deliveryKey}:${deliveryEpoch}` : null;
  const deliveryStateRef = useRef<{
    key: string | null;
    status: LoadStatus;
    error: unknown;
  }>({
    key: null,
    status: "idle",
    error: undefined,
  });
  const [deliveryState, setDeliveryState] = useState(deliveryStateRef.current);

  onOpenRef.current = options.onOpen;
  onResolveRef.current = options.onResolve;
  clearInviteParamsRef.current = clearInviteParamsOption;

  useEffect(() => {
    if (detectedInviteInput && detectedInviteInput !== latchedInviteInput) {
      setLatchedInviteInput(detectedInviteInput);
      return;
    }

    if (
      !detectedInviteInput
      && latchedInviteInput !== null
      && deliveryState.status === "success"
    ) {
      setLatchedInviteInput(null);
    }
  }, [deliveryState.status, detectedInviteInput, latchedInviteInput]);

  const resource = useOptionalResource(
    enabled
      && !!inviteInput
      && session.status === "success"
      && !!session.data?.signedIn,
    resourceKey,
    runtime,
    () => runtime.getLoadOnce(
      resourceKey as string,
      () => resolveInviteFromUrl<Schema, TOpened>(inviteInput as string, runtime.client),
      undefined,
      "ignore",
    ),
  );

  useEffect(() => {
    if (!enabled) {
      if (
        currentDeliveryKey
        && deliveryStateRef.current.key === currentDeliveryKey
        && deliveryStateRef.current.status === "loading"
      ) {
        const nextState = {
          key: currentDeliveryKey,
          status: "idle" as const,
          error: undefined,
        };
        deliveryStateRef.current = nextState;
        setDeliveryState(nextState);
      }
      return;
    }

    if (!currentDeliveryKey) {
      const nextState = {
        key: null,
        status: "idle" as const,
        error: undefined,
      };
      if (
        deliveryStateRef.current.key !== nextState.key
        || deliveryStateRef.current.status !== nextState.status
        || deliveryStateRef.current.error !== nextState.error
      ) {
        deliveryStateRef.current = nextState;
        setDeliveryState(nextState);
      }
      return;
    }

    if (resource.status !== "success" || resource.data === undefined) {
      const nextState = {
        key: currentDeliveryKey,
        status: "idle" as const,
        error: undefined,
      };
      if (
        deliveryStateRef.current.key !== nextState.key
        || deliveryStateRef.current.status !== nextState.status
        || deliveryStateRef.current.error !== nextState.error
      ) {
        deliveryStateRef.current = nextState;
        setDeliveryState(nextState);
      }
      return;
    }

    if (
      deliveryStateRef.current.key === currentDeliveryKey
      && (
        deliveryStateRef.current.status === "loading"
        || deliveryStateRef.current.status === "success"
        || deliveryStateRef.current.status === "error"
      )
    ) {
      return;
    }

    let cancelled = false;
    const resolvedInvite = resource.data;
    const nextLoadingState = {
      key: currentDeliveryKey,
      status: "loading" as const,
      error: undefined,
    };
    deliveryStateRef.current = nextLoadingState;
    setDeliveryState(nextLoadingState);

    void (async () => {
      try {
        if (resolvedInvite.kind === "opened") {
          await onOpenRef.current?.(resolvedInvite.row);
        }
        await onResolveRef.current?.(resolvedInvite);
        if (cancelled) {
          return;
        }

        const nextSuccessState = {
          key: currentDeliveryKey,
          status: "success" as const,
          error: undefined,
        };
        deliveryStateRef.current = nextSuccessState;
        setDeliveryState(nextSuccessState);

        if (clearInviteParamsRef.current) {
          clearInviteUrl(clearInviteParamsRef.current, inviteInput as string);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        const nextErrorState = {
          key: currentDeliveryKey,
          status: "error" as const,
          error,
        };
        deliveryStateRef.current = nextErrorState;
        setDeliveryState(nextErrorState);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentDeliveryKey, enabled, inviteInput, resource.data, resource.status]);

  const refresh = async (): Promise<void> => {
    if (session.status !== "success" || !session.data?.signedIn) {
      await session.refresh();
      return;
    }

    await resource.refresh();
    setDeliveryEpoch((epoch) => epoch + 1);
  };

  if (!inviteInput) {
    return {
      hasInvite: false,
      inviteInput: null,
      ...makeResourceResult({
        status: "idle",
      }, noopRefresh),
    };
  }

  if (!enabled) {
    return {
      hasInvite: true,
      inviteInput,
      ...makeResourceResult({
        status: "idle",
      }, noopRefresh),
    };
  }

  if (session.status === "error") {
    return {
      hasInvite: true,
      inviteInput,
      ...makeResourceResult({
        error: session.error,
        status: "error",
      }, refresh),
    };
  }

  if (session.status !== "success") {
    return {
      hasInvite: true,
      inviteInput,
      ...makeResourceResult({
        status: "loading",
      }, refresh),
    };
  }

  if (!session.data?.signedIn) {
    return {
      hasInvite: true,
      inviteInput,
      ...makeResourceResult({
        status: "idle",
      }, refresh),
    };
  }

  if (resource.status !== "success" || resource.data === undefined) {
    return {
      ...resource,
      hasInvite: true,
      inviteInput,
      refresh,
    };
  }

  if (
    deliveryState.key !== currentDeliveryKey
    || deliveryState.status === "idle"
    || deliveryState.status === "loading"
  ) {
    return {
      hasInvite: true,
      inviteInput,
      ...makeResourceResult({
        isRefreshing: resource.isRefreshing,
        refreshError: resource.refreshError,
        status: "loading",
      }, refresh),
    };
  }

  if (deliveryState.status === "error") {
    return {
      hasInvite: true,
      inviteInput,
      ...makeResourceResult({
        error: deliveryState.error,
        isRefreshing: resource.isRefreshing,
        refreshError: resource.refreshError,
        status: "error",
      }, refresh),
    };
  }

  return {
    ...resource,
    hasInvite: true,
    inviteInput,
    refresh,
  };
}

export function useSavedRow<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
  TResult = RowHandle<Schema, TCollection>,
>(
  db: Vennbase<Schema>,
  options: UseSavedRowOptions<Schema, TCollection, TResult>,
): UseSavedRowResult<TResult> {
  const runtime = useRuntime(db);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const sessionUser =
    session.status === "success" && session.data?.signedIn
      ? session.data.user
      : null;
  const resourceKey = sessionUser
    ? makeSavedRowKey(sessionUser.username, options.key)
    : null;

  const resource = useOptionalResource(
    (options.enabled ?? true)
      && !!resourceKey
      && session.status === "success"
      && !!session.data?.signedIn,
    resourceKey,
    runtime,
    () => runtime.getLoadOnce(
      resourceKey as string,
      async () => {
        try {
          const savedRow = await runtime.client.openSavedRow(options.key, options.collection);
          if (!savedRow) {
            return null;
          }

          return options.loadSavedRow
            ? await options.loadSavedRow(savedRow, runtime.client)
            : savedRow as TResult;
        } catch (error) {
          if (!(error instanceof SavedRowCollectionMismatchError)) {
            await runtime.client.clearSavedRow(options.key);
          }
          throw error;
        }
      },
      undefined,
      "refresh",
    ),
  );

  const refresh = async (): Promise<void> => {
    if (!(options.enabled ?? true)) {
      return;
    }

    if (session.status !== "success" || !session.data?.signedIn) {
      await session.refresh();
      return;
    }

    await resource.refresh();
  };

  const save = async (result: TResult): Promise<void> => {
    await runtime.client.saveRow(
      options.key,
      getRowFromResult(result, options.getRow),
    );
    await refresh();
  };

  const clear = async (): Promise<void> => {
    await runtime.client.clearSavedRow(options.key);
    await refresh();
  };

  if (!(options.enabled ?? true)) {
    return {
      ...makeResourceResult<TResult | null>({
        status: "idle",
      }, refresh),
      row: undefined,
      clear,
      save,
      refresh,
    };
  }

  if (session.status === "error") {
    return {
      ...makeResourceResult<TResult | null>({
        error: session.error,
        status: "error",
      }, refresh),
      row: undefined,
      clear,
      save,
      refresh,
    };
  }

  if (session.status !== "success") {
    return {
      ...makeResourceResult<TResult | null>({
        status: "loading",
      }, refresh),
      row: undefined,
      clear,
      save,
      refresh,
    };
  }

  if (!session.data?.signedIn) {
    return {
      ...makeResourceResult<TResult | null>({
        status: "idle",
      }, refresh),
      row: undefined,
      clear,
      save,
      refresh,
    };
  }

  return {
    ...resource,
    row: resource.data,
    clear,
    save,
    refresh,
  };
}

export interface MutationResult<TResult, TArgs extends unknown[]> {
  data: TResult | undefined;
  error: unknown;
  mutate: (...args: TArgs) => Promise<TResult>;
  reset(): void;
  status: Exclude<LoadStatus, "idle"> | "idle";
}

export function useMutation<TArgs extends unknown[], TResult>(
  mutation: (...args: TArgs) => Promise<TResult>,
): MutationResult<TResult, TArgs> {
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;

  const [state, setState] = useState<{
    data: TResult | undefined;
    error: unknown;
    status: Exclude<LoadStatus, "idle"> | "idle";
  }>({
    data: undefined,
    error: undefined,
    status: "idle",
  });

  return {
    ...state,
    async mutate(...args: TArgs): Promise<TResult> {
      setState((current) => ({
        data: current.data,
        error: undefined,
        status: "loading",
      }));

      try {
        const result = await mutationRef.current(...args);
        setState({
          data: result,
          error: undefined,
          status: "success",
        });
        return result;
      } catch (error) {
        setState((current) => ({
          data: current.data,
          error,
          status: "error",
        }));
        throw error;
      }
    },
    reset() {
      setState({
        data: undefined,
        error: undefined,
        status: "idle",
      });
    },
  };
}
