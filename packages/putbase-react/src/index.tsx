import "@heyputer/puter.js";

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
  DbMemberInfo,
  DbQueryOptions,
  DbRowLocator,
  DbRowRef,
  DbSchema,
  MemberRole,
  PutBaseUser,
  RowFields,
} from "@putbase/core";
import type { RowHandle } from "@putbase/core";

import type { ActivitySubscriber } from "./polling";
import {
  getDefaultRuntime,
  getIdleSnapshot,
  makeInviteLinkKey,
  makeIncomingInviteKey,
  makeMembersKey,
  makePerUserRowKey,
  makeParentsKey,
  makeQueryKey,
  makeRowKey,
  makeRowTargetKey,
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

export interface UseSessionResult extends UseResourceResult<AuthSession> {
  session: { state: "loading" } | AuthSession;
  signIn(): Promise<PutBaseUser>;
}

export interface UseHookOptions {
  enabled?: boolean;
}

export interface UseInviteFromLocationOptions<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
> extends UseHookOptions {
  href?: string | null;
  clearLocation?: boolean | ((url: URL) => string);
  onOpen?: (result: TResult) => void;
  open?: (inviteInput: string, client: PutBase<Schema>) => Promise<TResult>;
}

export interface UseInviteFromLocationResult<TResult> extends UseResourceResult<TResult> {
  hasInvite: boolean;
  inviteInput: string | null;
}

export interface UsePerUserRowOptions<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
> extends UseHookOptions {
  key: string;
  href?: string | null;
  clearLocation?: boolean | ((url: URL) => string);
  loadRememberedRow?: (row: AnyRowHandle<Schema>, client: PutBase<Schema>) => Promise<TResult> | TResult;
  openInvite?: (inviteInput: string, client: PutBase<Schema>) => Promise<TResult>;
  getRow?: (result: TResult) => Pick<DbRowLocator, "target">;
}

export interface UsePerUserRowResult<TResult> extends UseResourceResult<TResult | null> {
  hasInvite: boolean;
  inviteInput: string | null;
  remember(result: TResult): Promise<void>;
  clear(): Promise<void>;
}

export interface PutBaseProviderProps<Schema extends DbSchema> {
  children: ReactNode;
  client: PutBase<Schema>;
  subscribeToActivity?: ActivitySubscriber;
}

const RuntimeContext = createContext<PutBaseReactRuntime<any> | null>(null);

const noopSubscribe = () => () => undefined;
const noopRefresh = async () => undefined;

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

function useRuntime<Schema extends DbSchema>(client?: PutBase<Schema>): PutBaseReactRuntime<Schema> {
  const contextRuntime = useContext(RuntimeContext);
  if (client) {
    if (contextRuntime && contextRuntime.client === client) {
      return contextRuntime as PutBaseReactRuntime<Schema>;
    }

    return getDefaultRuntime(client);
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

  if (session.status !== "success" || session.data?.state !== "signed-in") {
    return makeResourceResult<TData>({
      status: "idle",
    }, session.refresh);
  }

  return null;
}

function getInviteHrefFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.has(PUTBASE_INVITE_TARGET_PARAM)) {
    return url.toString();
  }

  return null;
}

function clearInviteLocation(
  clearLocation: boolean | ((url: URL) => string),
  inviteInput: string,
): void {
  if (typeof window === "undefined") {
    return;
  }

  const current = new URL(window.location.href);
  if (current.toString() !== inviteInput) {
    return;
  }

  if (typeof clearLocation === "function") {
    window.history.replaceState({}, "", clearLocation(current));
    return;
  }

  current.search = "";
  window.history.replaceState({}, "", `${current.pathname}${current.hash}`);
}

function hasTarget(value: unknown): value is { target: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  return typeof (value as { target?: unknown }).target === "string";
}

function getRowFromResult<TResult>(
  result: TResult,
  getRow?: (result: TResult) => Pick<DbRowLocator, "target">,
): Pick<DbRowLocator, "target"> {
  const row = getRow
    ? getRow(result)
    : hasTarget(result)
      ? result
      : null;
  const normalized = row?.target?.trim();
  if (!normalized) {
    throw new Error("usePerUserRow could not resolve a row. Pass getRow when returning non-row data.");
  }
  return { target: normalized };
}

export function PutBaseProvider<Schema extends DbSchema>({
  children,
  client,
  subscribeToActivity,
}: PutBaseProviderProps<Schema>) {
  const runtimeRef = useRef<PutBaseReactRuntime<Schema> | null>(null);
  if (
    runtimeRef.current === null ||
    runtimeRef.current.client !== client ||
    runtimeRef.current.subscribeToActivity !== subscribeToActivity
  ) {
    runtimeRef.current = new Runtime(client, subscribeToActivity);
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

export function usePutBaseReady<Schema extends DbSchema>(
  client: PutBase<Schema>,
  options: UseHookOptions = {},
): UseResourceResult<void> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const blocked = blockedResourceResult<void>(session);
  const resource = useOptionalResource((options.enabled ?? true) && !blocked, "ready", runtime, () =>
    runtime.getLoadOnce("ready", () => runtime.client.ensureReady()),
  );
  return blocked ?? resource;
}

export function useSession<Schema extends DbSchema>(
  client: PutBase<Schema>,
  options: UseHookOptions = {},
): UseSessionResult {
  const runtime = useRuntime(client);
  const resource = useSessionResource(runtime, options.enabled ?? true);
  return {
    ...resource,
    session: resource.status === "success" && resource.data
      ? resource.data
      : { state: "loading" },
    async signIn(): Promise<PutBaseUser> {
      const user = await runtime.client.signIn();
      await resource.refresh();
      return user;
    },
  };
}

export function useCurrentUser<Schema extends DbSchema>(
  client: PutBase<Schema>,
  options: UseHookOptions = {},
): UseResourceResult<PutBaseUser> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  if (session.status === "error") {
    return makeResourceResult<PutBaseUser>({
      error: session.error,
      status: "error",
    }, session.refresh);
  }

  if (session.status !== "success" || session.data?.state !== "signed-in") {
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
  client: PutBase<Schema>,
  collection: TCollection,
  options: DbQueryOptions<Schema, TCollection> | null | undefined,
  hookOptions: UseHookOptions = {},
): UseQueryResult<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, hookOptions.enabled ?? true);
  const resourceKey = options ? makeQueryKey(collection, options) : null;
  const blocked = blockedResourceResult<Array<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>>>(session);
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
  client: PutBase<Schema>,
  row: DbRowRef<TCollection> | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const resourceKey = row ? makeRowKey(row.collection, row) : null;
  const blocked = blockedResourceResult<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!row && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.getRow(
        (row as DbRowRef<TCollection>).collection,
        row as DbRowRef<TCollection>,
      ) as Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>>,
      snapshots.row,
    ),
  );
  return blocked ?? resource;
}

export function useRowTarget<Schema extends DbSchema>(
  client: PutBase<Schema>,
  target: string | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<AnyRowHandle<Schema>> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const resourceKey = target ? makeRowTargetKey(target) : null;
  const blocked = blockedResourceResult<AnyRowHandle<Schema>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!target && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.openTarget(target as string),
      snapshots.row,
    ),
  );
  return blocked ?? resource;
}

export function useParents<Schema extends DbSchema>(
  client: PutBase<Schema>,
  row: DbRowRef | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<DbRowRef>> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const resourceKey = row ? makeParentsKey(row) : null;
  const blocked = blockedResourceResult<Array<DbRowRef>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!row && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.listParents(row as DbRowRef),
      snapshots.rowRefs,
    ),
  );
  return blocked ?? resource;
}

export function useMemberUsernames<Schema extends DbSchema>(
  client: PutBase<Schema>,
  row: DbRowLocator | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<string[]> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const resourceKey = row ? makeMembersKey("usernames", row) : null;
  const blocked = blockedResourceResult<string[]>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!row && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.listMembers(row as DbRowLocator),
      snapshots.memberUsernames,
    ),
  );
  return blocked ?? resource;
}

export function useDirectMembers<Schema extends DbSchema>(
  client: PutBase<Schema>,
  row: DbRowLocator | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<{ username: string; role: MemberRole }>> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const resourceKey = row ? makeMembersKey("direct", row) : null;
  const blocked = blockedResourceResult<Array<{ username: string; role: MemberRole }>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!row && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.listDirectMembers(row as DbRowLocator),
      snapshots.directMembers,
    ),
  );
  return blocked ?? resource;
}

export function useEffectiveMembers<Schema extends DbSchema>(
  client: PutBase<Schema>,
  row: DbRowLocator | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<Array<DbMemberInfo<Schema>>> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const resourceKey = row ? makeMembersKey("effective", row) : null;
  const blocked = blockedResourceResult<Array<DbMemberInfo<Schema>>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!row && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.listEffectiveMembers(row as DbRowLocator),
      snapshots.effectiveMembers,
    ),
  );
  return blocked ?? resource;
}

export function useInviteLink<Schema extends DbSchema>(
  client: PutBase<Schema>,
  row: DbRowRef | null | undefined,
  options: UseHookOptions = {},
): UseResourceResult<string> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const resourceKey = row ? makeInviteLinkKey(row as DbRowRef) : null;
  const blocked = blockedResourceResult<string>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!row && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLoadOnce(
      resourceKey as string,
      async () => {
        const existing = await runtime.client.getExistingInviteToken(row as DbRowRef);
        const invite = existing ?? await runtime.client.createInviteToken(row as DbRowRef);
        return runtime.client.createInviteLink(row as DbRowRef, invite.token);
      },
    ),
  );
  return blocked ?? resource;
}

export function useInviteFromLocation<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
>(
  client: PutBase<Schema>,
  options: UseInviteFromLocationOptions<Schema, TResult> = {},
): UseInviteFromLocationResult<TResult> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const inviteInput = options.href ?? getInviteHrefFromLocation();
  const resourceKey = inviteInput ? makeIncomingInviteKey(inviteInput) : null;
  const clearLocationOption = options.clearLocation ?? true;
  const deliveredInviteRef = useRef<string | null>(null);
  const clearedInviteRef = useRef<string | null>(null);
  const onOpenRef = useRef(options.onOpen);
  const openRef = useRef(options.open);

  onOpenRef.current = options.onOpen;
  openRef.current = options.open;

  const resource = useOptionalResource(
    (options.enabled ?? true)
      && !!inviteInput
      && session.status === "success"
      && session.data?.state === "signed-in",
    resourceKey,
    runtime,
    () => runtime.getLoadOnce(
      resourceKey as string,
      () => {
        const openInvite = openRef.current;
        if (openInvite) {
          return openInvite(inviteInput as string, runtime.client);
        }

        return runtime.client.openInvite(inviteInput as string) as Promise<TResult>;
      },
    ),
  );

  useEffect(() => {
    if (!inviteInput || resource.status !== "success" || resource.data === undefined) {
      return;
    }

    if (onOpenRef.current && deliveredInviteRef.current !== inviteInput) {
      deliveredInviteRef.current = inviteInput;
      onOpenRef.current(resource.data);
    }

    if (clearLocationOption && clearedInviteRef.current !== inviteInput) {
      clearedInviteRef.current = inviteInput;
      clearInviteLocation(clearLocationOption, inviteInput);
    }
  }, [clearLocationOption, inviteInput, resource.data, resource.status]);

  if (!(options.enabled ?? true) || !inviteInput) {
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
      }, session.refresh),
    };
  }

  if (session.status !== "success") {
    return {
      hasInvite: true,
      inviteInput,
      ...makeResourceResult({
        status: "loading",
      }, session.refresh),
    };
  }

  if (session.data?.state !== "signed-in") {
    return {
      hasInvite: true,
      inviteInput,
      ...makeResourceResult({
        status: "idle",
      }, session.refresh),
    };
  }

  return {
    ...resource,
    hasInvite: true,
    inviteInput,
  };
}

export function usePerUserRow<
  Schema extends DbSchema,
  TResult = AnyRowHandle<Schema>,
>(
  client: PutBase<Schema>,
  options: UsePerUserRowOptions<Schema, TResult>,
): UsePerUserRowResult<TResult> {
  const runtime = useRuntime(client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const inviteInput = options.href ?? getInviteHrefFromLocation();
  const clearLocationOption = options.clearLocation ?? true;
  const sessionUser =
    session.status === "success" && session.data?.state === "signed-in"
      ? session.data.user
      : null;
  const scopeKey = sessionUser ? `${sessionUser.username}:${options.key}` : null;
  const resourceKey = sessionUser
    ? makePerUserRowKey(sessionUser.username, options.key, inviteInput)
    : null;
  const [localData, setLocalData] = useState<{ scopeKey: string; data: TResult | null } | null>(null);
  const clearedInviteRef = useRef<string | null>(null);

  const resource = useOptionalResource(
    (options.enabled ?? true)
      && !!resourceKey
      && session.status === "success"
      && session.data?.state === "signed-in",
    resourceKey,
    runtime,
    () => runtime.getLoadOnce(
      resourceKey as string,
      async () => {
        if (inviteInput) {
          const opened = options.openInvite
            ? await options.openInvite(inviteInput, runtime.client)
            : await runtime.client.openInvite(inviteInput) as TResult;
          await runtime.client.rememberPerUserRow(
            options.key,
            getRowFromResult(opened, options.getRow),
          );
          return opened;
        }

        try {
          const rememberedRow = await runtime.client.openRememberedPerUserRow(options.key);
          if (!rememberedRow) {
            return null;
          }

          return options.loadRememberedRow
            ? await options.loadRememberedRow(rememberedRow, runtime.client)
            : rememberedRow as TResult;
        } catch (error) {
          await runtime.client.clearRememberedPerUserRow(options.key);
          throw error;
        }
      },
    ),
  );

  useEffect(() => {
    if (!inviteInput || resource.status !== "success") {
      return;
    }

    if (clearLocationOption && clearedInviteRef.current !== inviteInput) {
      clearedInviteRef.current = inviteInput;
      clearInviteLocation(clearLocationOption, inviteInput);
    }
  }, [clearLocationOption, inviteInput, resource.status]);

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

    if (session.status !== "success" || session.data?.state !== "signed-in") {
      await session.refresh();
      return;
    }

    await resource.refresh();
  };

  const remember = async (result: TResult): Promise<void> => {
    await runtime.client.rememberPerUserRow(
      options.key,
      getRowFromResult(result, options.getRow),
    );
    if (scopeKey) {
      setLocalData({ scopeKey, data: result });
    }
  };

  const clear = async (): Promise<void> => {
    await runtime.client.clearRememberedPerUserRow(options.key);
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
      remember,
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
      remember,
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
      remember,
      refresh,
    };
  }

  if (session.data?.state !== "signed-in") {
    return {
      ...makeResourceResult<TResult | null>({
        status: "idle",
      }, refresh),
      clear,
      hasInvite: !!inviteInput,
      inviteInput,
      remember,
      refresh,
    };
  }

  return {
    ...effective,
    clear,
    hasInvite: !!inviteInput,
    inviteInput,
    remember,
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
