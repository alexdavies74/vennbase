import { PUTBASE_INVITE_TARGET_PARAM } from "@putbase/core";
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
import type { PutBase } from "@putbase/core";
import type {
  AuthSession,
  AnyRowHandle,
  CollectionName,
  CrdtAdapter,
  CrdtConnectCallbacks,
  CrdtConnection,
  DbMemberInfo,
  DbQueryOptions,
  DbSchema,
  MemberRole,
  PutBaseUser,
  RowRef,
  RowInput,
} from "@putbase/core";
import type { RowHandle } from "@putbase/core";

import type { ActivitySubscriber } from "./polling";
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
  type PutBaseReactRuntime,
  type QueryRows,
  type ResourceController,
  type ResourceSnapshot,
  snapshots,
} from "./runtime";
import { PutBaseReactRuntime as Runtime } from "./runtime";

export type { ActivitySubscriber } from "./polling";
export type { LoadStatus } from "./runtime";

export interface UseResourceResult<TData> extends ResourceSnapshot<TData> {
  refresh(): Promise<void>;
}

export interface UseQueryResult<TRow> extends UseResourceResult<TRow[]> {
  rows: TRow[];
}

export type UseShareLinkResult = Omit<UseResourceResult<string>, "data"> & {
  shareLink: string | undefined;
};

export interface UseSessionResult extends UseResourceResult<AuthSession> {
  session: AuthSession | undefined;
  signIn(): Promise<PutBaseUser>;
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

export interface UseAcceptInviteFromUrlOptions<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
> extends UseHookOptions {
  url?: string | null;
  clearInviteParams?: boolean | ((url: URL) => string);
  onOpen?: (result: TResult) => void | Promise<void>;
  accept?: (inviteInput: string, pb: PutBase<Schema>) => Promise<TResult>;
}

export interface UseAcceptInviteFromUrlResult<TResult> extends UseResourceResult<TResult> {
  hasInvite: boolean;
  inviteInput: string | null;
}

export interface UseSavedRowOptions<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
> extends UseHookOptions {
  key: string;
  url?: string | null;
  clearInviteParams?: boolean | ((url: URL) => string);
  loadSavedRow?: (row: AnyRowHandle<Schema>, pb: PutBase<Schema>) => Promise<TResult> | TResult;
  acceptInvite?: (inviteInput: string, pb: PutBase<Schema>) => Promise<TResult>;
  getRow?: (result: TResult) => RowRef;
}

export interface UseSavedRowResult<TResult> extends UseResourceResult<TResult | null> {
  hasInvite: boolean;
  inviteInput: string | null;
  save(result: TResult): Promise<void>;
  clear(): Promise<void>;
}

export interface PutBaseProviderProps<Schema extends DbSchema> {
  children: ReactNode;
  pb: PutBase<Schema>;
  subscribeToActivity?: ActivitySubscriber;
  client?: never;
  db?: never;
}

const RuntimeContext = createContext<PutBaseReactRuntime<any> | null>(null);

const noopSubscribe = () => () => undefined;
const noopRefresh = async () => undefined;
const noopFlush = async () => undefined;

interface CrdtRowLike {
  ref: RowRef;
  connectCrdt(callbacks: CrdtConnectCallbacks): CrdtConnection;
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
    status: snapshot.status,
    refresh,
  };
}

function useRuntime<Schema extends DbSchema>(pb?: PutBase<Schema>): PutBaseReactRuntime<Schema> {
  const contextRuntime = useContext(RuntimeContext);
  if (pb) {
    if (contextRuntime && contextRuntime.client === pb) {
      return contextRuntime as PutBaseReactRuntime<Schema>;
    }

    return getDefaultRuntime(pb);
  }

  if (!contextRuntime) {
    throw new Error("PutBaseProvider is missing.");
  }

  return contextRuntime as PutBaseReactRuntime<Schema>;
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
  runtime: PutBaseReactRuntime<Schema>,
  enabled: boolean,
): UseResourceResult<AuthSession> {
  return useOptionalResource(
    enabled,
    "session",
    runtime,
    () => runtime.getLoadOnce("session", () => runtime.client.getSession(), snapshots.session),
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
  if (url.searchParams.has(PUTBASE_INVITE_TARGET_PARAM)) {
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

function resolveRowInput<TCollection extends string>(row: RowInput<TCollection>): RowRef<TCollection> {
  return hasRowRef(row) ? row.ref as RowRef<TCollection> : row;
}

function getRowFromResult<TResult>(
  result: TResult,
  getRow?: (result: TResult) => RowRef,
): RowRef {
  const row = getRow
    ? getRow(result)
    : hasRowRef(result)
      ? result.ref
      : null;
  if (!row) {
    throw new Error("useSavedRow could not resolve a row. Pass getRow when returning non-row data.");
  }
  return row;
}

export function PutBaseProvider<Schema extends DbSchema>({
  children,
  pb,
  subscribeToActivity,
}: PutBaseProviderProps<Schema>) {

  const runtimeRef = useRef<PutBaseReactRuntime<Schema> | null>(null);
  if (
    runtimeRef.current === null ||
    runtimeRef.current.client !== pb ||
    runtimeRef.current.externalSubscribeToActivity !== subscribeToActivity
  ) {
    runtimeRef.current = new Runtime(pb, subscribeToActivity);
  }

  return (
    <RuntimeContext.Provider value={runtimeRef.current}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function usePutBase<Schema extends DbSchema>(): PutBase<Schema> {
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

export function usePutBaseReady<Schema extends DbSchema>(
  pb: PutBase<Schema>,
  options: UseHookOptions = {},
): UseResourceResult<void> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const blocked = blockedResourceResult<void>(session);
  const resource = useOptionalResource((options.enabled ?? true) && !blocked, "ready", runtime, () =>
    runtime.getLoadOnce("ready", () => runtime.client.ensureReady()),
  );
  return blocked ?? resource;
}

export function useSession<Schema extends DbSchema>(
  pb: PutBase<Schema>,
  options: UseHookOptions = {},
): UseSessionResult {
  const runtime = useRuntime(pb);
  const resource = useSessionResource(runtime, options.enabled ?? true);
  return {
    ...resource,
    session: resource.status === "success" ? resource.data : undefined,
    async signIn(): Promise<PutBaseUser> {
      const user = await runtime.client.signIn();
      await resource.refresh();
      return user;
    },
  };
}

export function useCurrentUser<Schema extends DbSchema>(
  pb: PutBase<Schema>,
  options: UseHookOptions = {},
): UseResourceResult<PutBaseUser> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  if (session.status === "error") {
    return makeResourceResult<PutBaseUser>({
      error: session.error,
      status: "error",
    }, session.refresh);
  }

  if (session.status !== "success" || !session.data?.signedIn) {
    return makeResourceResult<PutBaseUser>({
      status: "idle",
    }, session.refresh);
  }

  return makeResourceResult<PutBaseUser>({
    data: session.data.user,
    status: "success",
  }, session.refresh);
}

export function useQuery<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  pb: PutBase<Schema>,
  collection: TCollection,
  options: DbQueryOptions<Schema, TCollection> | null | undefined,
  hookOptions: UseHookOptions = {},
): UseQueryResult<
  RowHandle<Schema, TCollection>
> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, hookOptions.enabled ?? true);
  const resourceKey = options ? makeQueryKey(collection, options) : null;
  const blocked = blockedResourceResult<Array<RowHandle<Schema, TCollection>>>(session);
  const resource = useOptionalResource(
    (hookOptions.enabled ?? true) && !!options && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.query(collection, options as DbQueryOptions<Schema, TCollection>) as Promise<QueryRows<Schema, TCollection>>,
      snapshots.queryRows,
    ),
  );

  return {
    ...(blocked ?? resource),
    rows: (blocked ?? resource).data ?? [],
  };
}

export function useRow<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  pb: PutBase<Schema>,
  row: RowInput<TCollection> | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<
  RowHandle<Schema, TCollection>
> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? resolveRowInput(row) : null;
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
  return blocked ?? resource;
}

export function useParents<Schema extends DbSchema>(
  pb: PutBase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<RowRef>> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? resolveRowInput(row) : null;
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
  pb: PutBase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<string[]> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? resolveRowInput(row) : null;
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
  pb: PutBase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<{ username: string; role: MemberRole }>> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? resolveRowInput(row) : null;
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
  pb: PutBase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<DbMemberInfo<Schema>>> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? resolveRowInput(row) : null;
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
  pb: PutBase<Schema>,
  row: RowInput | null | undefined,
  options: UseHookOptions = {},
): UseShareLinkResult {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const rowRef = row ? resolveRowInput(row) : null;
  const resourceKey = rowRef ? makeShareLinkKey(rowRef) : null;
  const blocked = blockedResourceResult<string>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!rowRef && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLoadOnce(
      resourceKey as string,
      async () => {
        const existing = await runtime.client.getExistingInviteToken(rowRef as RowRef);
        const invite = existing ?? runtime.client.createInviteToken(rowRef as RowRef).value;
        return runtime.client.createShareLink(rowRef as RowRef, invite.token);
      },
    ),
  );
  const result = blocked ?? resource;

  return {
    shareLink: result.data,
    error: result.error,
    refreshError: result.refreshError,
    isRefreshing: result.isRefreshing,
    status: result.status,
    refresh: result.refresh,
  };
}

export function useAcceptInviteFromUrl<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
>(
  pb: PutBase<Schema>,
  options: UseAcceptInviteFromUrlOptions<Schema, TResult> = {},
): UseAcceptInviteFromUrlResult<TResult> {
  const runtime = useRuntime(pb);
  const enabled = options.enabled ?? true;
  const session = useSessionResource(runtime, options.enabled ?? true);
  const detectedInviteInput = options.url ?? getInviteInputFromUrl();
  const [latchedInviteInput, setLatchedInviteInput] = useState<string | null>(detectedInviteInput);
  const inviteInput = enabled
    ? detectedInviteInput ?? latchedInviteInput
    : null;
  const resourceKey = inviteInput ? makeIncomingInviteKey(inviteInput) : null;
  const clearInviteParamsOption = options.clearInviteParams ?? true;
  const deliveryKey = inviteInput ?? null;
  const onOpenRef = useRef(options.onOpen);
  const acceptRef = useRef(options.accept);
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
  acceptRef.current = options.accept;
  clearInviteParamsRef.current = clearInviteParamsOption;

  useEffect(() => {
    if (!enabled) {
      if (latchedInviteInput !== null) {
        setLatchedInviteInput(null);
      }
      return;
    }

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
  }, [deliveryState.status, detectedInviteInput, enabled, latchedInviteInput]);

  const resource = useOptionalResource(
    (options.enabled ?? true)
      && !!inviteInput
      && session.status === "success"
      && !!session.data?.signedIn,
    resourceKey,
    runtime,
    () => runtime.getLoadOnce(
      resourceKey as string,
      () => {
        const acceptInvite = acceptRef.current;
        if (acceptInvite) {
          return acceptInvite(inviteInput as string, runtime.client);
        }

        return runtime.client.acceptInvite(inviteInput as string) as Promise<TResult>;
      },
    ),
  );

  useEffect(() => {
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
    const openedResult = resource.data;
    const nextLoadingState = {
      key: currentDeliveryKey,
      status: "loading" as const,
      error: undefined,
    };
    deliveryStateRef.current = nextLoadingState;
    setDeliveryState(nextLoadingState);

    void (async () => {
      try {
        await onOpenRef.current?.(openedResult);
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
  }, [currentDeliveryKey, inviteInput, resource.data, resource.status]);

  const refresh = async (): Promise<void> => {
    if (session.status !== "success" || !session.data?.signedIn) {
      await session.refresh();
      return;
    }

    await resource.refresh();
    setDeliveryEpoch((epoch) => epoch + 1);
  };

  if (!enabled || !inviteInput) {
    return {
      hasInvite: false,
      inviteInput: null,
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
  TResult = AnyRowHandle<Schema>,
>(
  pb: PutBase<Schema>,
  options: UseSavedRowOptions<Schema, TResult>,
): UseSavedRowResult<TResult> {
  const runtime = useRuntime(pb);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const inviteInput = options.url ?? getInviteInputFromUrl();
  const clearInviteParamsOption = options.clearInviteParams ?? true;
  const sessionUser =
    session.status === "success" && session.data?.signedIn
      ? session.data.user
      : null;
  const scopeKey = sessionUser ? `${sessionUser.username}:${options.key}` : null;
  const resourceKey = sessionUser
    ? makeSavedRowKey(sessionUser.username, options.key, inviteInput)
    : null;
  const [localData, setLocalData] = useState<{ scopeKey: string; data: TResult | null } | null>(null);
  const clearedInviteRef = useRef<string | null>(null);

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
        if (inviteInput) {
          const opened = options.acceptInvite
            ? await options.acceptInvite(inviteInput, runtime.client)
            : await runtime.client.acceptInvite(inviteInput) as TResult;
          await runtime.client.saveRow(
            options.key,
            getRowFromResult(opened, options.getRow),
          );
          return opened;
        }

        try {
          const savedRow = await runtime.client.openSavedRow(options.key);
          if (!savedRow) {
            return null;
          }

          return options.loadSavedRow
            ? await options.loadSavedRow(savedRow, runtime.client)
            : savedRow as TResult;
        } catch (error) {
          await runtime.client.clearSavedRow(options.key);
          throw error;
        }
      },
    ),
  );

  useEffect(() => {
    if (!inviteInput || resource.status !== "success") {
      return;
    }

    if (clearInviteParamsOption && clearedInviteRef.current !== inviteInput) {
      clearedInviteRef.current = inviteInput;
      clearInviteUrl(clearInviteParamsOption, inviteInput);
    }
  }, [clearInviteParamsOption, inviteInput, resource.status]);

  const localOverride = localData && localData.scopeKey === scopeKey
    ? localData
    : null;
  const effective = localOverride
    ? makeResourceResult({
      data: localOverride.data,
      status: "success" as const,
    })
    : resource;

  const refresh = async (): Promise<void> => {
    if (localOverride) {
      setLocalData(null);
    }

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
    if (scopeKey) {
      setLocalData({ scopeKey, data: result });
    }
  };

  const clear = async (): Promise<void> => {
    await runtime.client.clearSavedRow(options.key);
    if (scopeKey) {
      setLocalData({ scopeKey, data: null });
      return;
    }

    setLocalData(null);
  };

  if (!(options.enabled ?? true)) {
    return {
      ...makeResourceResult<TResult | null>({
        status: "idle",
      }, refresh),
      clear,
      hasInvite: !!inviteInput,
      inviteInput,
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
      clear,
      hasInvite: !!inviteInput,
      inviteInput,
      save,
      refresh,
    };
  }

  if (session.status !== "success") {
    return {
      ...makeResourceResult<TResult | null>({
        status: "loading",
      }, refresh),
      clear,
      hasInvite: !!inviteInput,
      inviteInput,
      save,
      refresh,
    };
  }

  if (!session.data?.signedIn) {
    return {
      ...makeResourceResult<TResult | null>({
        status: "idle",
      }, refresh),
      clear,
      hasInvite: !!inviteInput,
      inviteInput,
      save,
      refresh,
    };
  }

  return {
    ...effective,
    clear,
    hasInvite: !!inviteInput,
    inviteInput,
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
