import {
  createContext,
  type ReactNode,
  useContext,
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
  RowFields,
  RoomUser,
} from "@putbase/core";
import type { RowHandle } from "@putbase/core";

import type { ActivitySubscriber } from "./polling";
import {
  getDefaultRuntime,
  getIdleSnapshot,
  makeInviteLinkKey,
  makeMembersKey,
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
  signIn(): Promise<RoomUser>;
}

export interface UseHookOptions<Schema extends DbSchema> {
  client?: PutBase<Schema>;
  enabled?: boolean;
}

export interface PutBaseProviderProps<Schema extends DbSchema> {
  children: ReactNode;
  client: PutBase<Schema>;
  subscribeToActivity?: ActivitySubscriber;
}

const RuntimeContext = createContext<PutBaseReactRuntime<any> | null>(null);

const noopSubscribe = () => () => undefined;
const noopRefresh = async () => undefined;

function useRuntime<Schema extends DbSchema>(client?: PutBase<Schema>): PutBaseReactRuntime<Schema> {
  const contextRuntime = useContext(RuntimeContext);
  if (client) {
    return getDefaultRuntime(client);
  }

  if (!contextRuntime) {
    throw new Error("PutBaseProvider is missing and no client override was provided.");
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
    return {
      data: undefined,
      error: session.error,
      status: "error",
      refresh: session.refresh,
    };
  }

  if (session.status !== "success" || session.data?.state !== "signed-in") {
    return {
      data: undefined,
      error: undefined,
      status: "idle",
      refresh: session.refresh,
    };
  }

  return null;
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
  options: UseHookOptions<Schema> = {},
): UseResourceResult<void> {
  const runtime = useRuntime(options.client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const blocked = blockedResourceResult<void>(session);
  const resource = useOptionalResource((options.enabled ?? true) && !blocked, "ready", runtime, () =>
    runtime.getLoadOnce("ready", () => runtime.client.ensureReady()),
  );
  return blocked ?? resource;
}

export function useSession<Schema extends DbSchema>(
  options: UseHookOptions<Schema> = {},
): UseSessionResult {
  const runtime = useRuntime(options.client);
  const resource = useSessionResource(runtime, options.enabled ?? true);
  return {
    ...resource,
    session: resource.status === "success" && resource.data
      ? resource.data
      : { state: "loading" },
    async signIn(): Promise<RoomUser> {
      const user = await runtime.client.signIn();
      await resource.refresh();
      return user;
    },
  };
}

export function useCurrentUser<Schema extends DbSchema>(
  options: UseHookOptions<Schema> = {},
): UseResourceResult<RoomUser> {
  const runtime = useRuntime(options.client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  if (session.status === "error") {
    return {
      data: undefined,
      error: session.error,
      status: "error",
      refresh: session.refresh,
    };
  }

  if (session.status !== "success" || session.data?.state !== "signed-in") {
    return {
      data: undefined,
      error: undefined,
      status: "idle",
      refresh: session.refresh,
    };
  }

  return {
    data: session.data.user,
    error: undefined,
    status: "success",
    refresh: session.refresh,
  };
}

export function useQuery<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
>(
  collection: TCollection,
  options: DbQueryOptions<Schema, TCollection> | null | undefined,
  hookOptions: UseHookOptions<Schema> = {},
): UseQueryResult<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>> {
  const runtime = useRuntime(hookOptions.client);
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
  collection: TCollection,
  row: DbRowRef<TCollection> | null | undefined,
  options: UseHookOptions<Schema> = {},
): UseResourceResult<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>> {
  const runtime = useRuntime(options.client);
  const session = useSessionResource(runtime, options.enabled ?? true);
  const resourceKey = row ? makeRowKey(collection, row) : null;
  const blocked = blockedResourceResult<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>>(session);
  const resource = useOptionalResource(
    (options.enabled ?? true) && !!row && !blocked,
    resourceKey,
    runtime,
    () => runtime.getLive(
      resourceKey as string,
      () => runtime.client.getRow(collection, row as DbRowRef<TCollection>) as Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, any, Schema>>,
      snapshots.row,
    ),
  );
  return blocked ?? resource;
}

export function useRowTarget<Schema extends DbSchema>(
  target: string | null | undefined,
  options: UseHookOptions<Schema> = {},
): UseResourceResult<AnyRowHandle<Schema>> {
  const runtime = useRuntime(options.client);
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
  row: DbRowRef | null | undefined,
  options: UseHookOptions<Schema> = {},
): UseResourceResult<Array<DbRowRef>> {
  const runtime = useRuntime(options.client);
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
  row: DbRowLocator | null | undefined,
  options: UseHookOptions<Schema> = {},
): UseResourceResult<string[]> {
  const runtime = useRuntime(options.client);
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
  row: DbRowLocator | null | undefined,
  options: UseHookOptions<Schema> = {},
): UseResourceResult<Array<{ username: string; role: MemberRole }>> {
  const runtime = useRuntime(options.client);
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
  row: DbRowLocator | null | undefined,
  options: UseHookOptions<Schema> = {},
): UseResourceResult<Array<DbMemberInfo<Schema>>> {
  const runtime = useRuntime(options.client);
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
  row: DbRowRef | null | undefined,
  options: UseHookOptions<Schema> = {},
): UseResourceResult<string> {
  const runtime = useRuntime(options.client);
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
