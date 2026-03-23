import { AuthManager } from "./auth";
import { Identity } from "./identity";
import { Invites } from "./invites";
import { Members } from "./members";
import { createMutationReceipt, type MutableMutationReceipt, type MutationReceipt } from "./mutation-receipt";
import { OptimisticStore } from "./optimistic-store";
import { Parents } from "./parents";
import {
  clearRememberedPerUserRow,
  loadRememberedPerUserRow,
  rememberPerUserRow,
} from "./per-user-rows";
import { Provisioning } from "./provisioning";
import { Query } from "./query";
import { RowHandle, type AnyRowHandle, type RowHandleBackend } from "./row-handle";
import { RowRuntime } from "./row-runtime";
import { Rows } from "./rows";
import { WritePlanner } from "./write-planner";
import { WriteSettler } from "./write-settler";
import type {
  AllowedParentCollections,
  CollectionName,
  DbMemberInfo,
  DbPutArgs,
  DbRowLocator,
  DbPutOptions,
  DbQueryOptions,
  DbQueryWatchCallbacks,
  DbQueryWatchHandle,
  DbRowRef,
  DbSchema,
  InsertFields,
  MemberRole,
  RowFields,
} from "./schema";
import { resolveBackend } from "./backend";
import { missingPuterProvisioningMessage } from "./errors";
import { BUILTIN_USER_SCOPE as USER_SCOPE_COLLECTION, getCollectionSpec, hasImplicitUserScope, resolveCollectionName } from "./schema";
import { stableJsonStringify } from "./stable-json";
import { normalizeTarget } from "./transport";
import { Transport } from "./transport";
import type {
  AuthSession,
  BackendClient,
  CrdtConnectCallbacks,
  CrdtConnection,
  DeployWorkerArgs,
  InviteTarget,
  InviteToken,
  JsonValue,
  PutBaseUser,
} from "./types";
import { Sync } from "./sync";

export interface PutBaseOptions<Schema extends DbSchema = DbSchema> {
  schema: Schema;
  backend?: BackendClient;
  fetchFn?: typeof fetch;
  appBaseUrl?: string;
  identityProvider?: () => Promise<PutBaseUser>;
  deployWorker?: (args: DeployWorkerArgs) => Promise<string | void>;
}

interface CachedRowHandle<Schema extends DbSchema> {
  handle: AnyRowHandle<Schema>;
  snapshot: string;
}

interface ReadyMutationState {
  user: PutBaseUser;
  federationWorkerUrl: string;
  userScopeRow: DbRowRef<typeof USER_SCOPE_COLLECTION> | null;
}

const INTERNAL_USER_SCOPE_ROW_KEY = "__putbase_user_scope_v1__";
type LocalMutationListener = () => void;

export class PutBase<Schema extends DbSchema = DbSchema> implements RowHandleBackend<Schema> {
  private readonly auth: AuthManager;
  private readonly transport: Transport;
  private readonly identity: Identity;
  private readonly provisioning: Provisioning;
  private readonly rowRuntime: RowRuntime;
  private readonly invitesModule: Invites;
  private readonly syncModule: Sync;
  private readonly membersModule: Members<Schema>;
  private readonly parentsModule: Parents;
  private readonly rowsModule: Rows<Schema>;
  private readonly queryModule: Query<Schema>;
  private readonly optimisticStore = new OptimisticStore();
  private readonly writeSettler = new WriteSettler();
  private readonly writePlanner: WritePlanner;
  private readonly requiresImplicitUserScope: boolean;
  private ready = false;
  private readinessPromise: Promise<void> | null = null;
  private pendingReadinessError: unknown | null = null;
  private readyMutationState: ReadyMutationState | null = null;
  private readonly rowHandleCache = new Map<string, CachedRowHandle<Schema>>();
  private readonly localMutationListeners = new Set<LocalMutationListener>();

  constructor(private readonly options: PutBaseOptions<Schema>) {
    this.identity = new Identity(options);
    this.auth = new AuthManager(resolveBackend(options.backend), () => this.identity.whoAmI().then((u) => u.username));
    this.transport = new Transport(options, this.auth);
    this.provisioning = new Provisioning(options, this.transport, this.identity, this.auth);
    this.syncRuntime();
    this.writePlanner = new WritePlanner(this.transport);
    this.requiresImplicitUserScope = Object.values(options.schema).some((collectionSpec) => hasImplicitUserScope(collectionSpec));
    this.rowRuntime = new RowRuntime(
      this.transport,
      this.identity,
      this.provisioning,
      () => this.awaitSharedReadiness(),
    );
    this.invitesModule = new Invites(options, this.transport, this.identity);
    this.syncModule = new Sync(this.rowRuntime);
    this.membersModule = new Members<Schema>(this.transport);
    this.rowsModule = new Rows(
      this.transport,
      this.rowRuntime,
      options.schema,
      this.optimisticStore,
      this.writeSettler,
      (collection, row, fields) => this.materializeRowHandle(collection, row, fields),
      (child, parent) => this.parentsModule.addRemote(child, parent),
      () => this.notifyLocalMutation(),
    );
    this.parentsModule = new Parents(
      this.transport,
      this.rowRuntime,
      options.schema,
      (row) => this.rowsModule.refreshFields(row),
    );
    this.queryModule = new Query(
      this.transport,
      { getRow: (collection, row) => this.rowsModule.getRow(collection, row) },
      this.optimisticStore,
      options.schema,
      (collection, queryOptions) => this.resolveImplicitQueryOptions(collection, queryOptions),
    );
    this.startPrewarmIfSignedIn();
  }

  async ensureReady(): Promise<void> {
    await this.awaitSharedReadiness();
  }

  async getSession(): Promise<AuthSession> {
    return this.identity.getSession();
  }

  async signIn(): Promise<PutBaseUser> {
    this.resetSessionState();
    const user = await this.identity.signIn();
    void this.startReadiness().catch(() => undefined);
    return user;
  }

  async whoAmI(): Promise<PutBaseUser> {
    return this.identity.whoAmI();
  }

  async rememberPerUserRow(rowKey: string, row: Pick<DbRowLocator, "target">): Promise<void> {
    const user = await this.identity.whoAmI();
    await rememberPerUserRow(resolveBackend(this.options.backend), user.username, rowKey, row);
  }

  async openRememberedPerUserRow(rowKey: string): Promise<AnyRowHandle<Schema> | null> {
    const user = await this.identity.whoAmI();
    const rememberedRow = await loadRememberedPerUserRow(
      resolveBackend(this.options.backend),
      user.username,
      rowKey,
    );
    if (!rememberedRow) {
      return null;
    }

    return this.openTarget(rememberedRow.target);
  }

  async clearRememberedPerUserRow(rowKey: string): Promise<void> {
    const user = await this.identity.whoAmI();
    await clearRememberedPerUserRow(resolveBackend(this.options.backend), user.username, rowKey);
  }

  put<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    ...args: DbPutArgs<Schema, TCollection>
  ): RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema> {
    const options = args[0];
    const row = this.rowsModule.put(collection, fields, this.resolveImplicitPutOptionsSync(collection, options));
    this.notifyLocalMutation();
    return row;
  }

  update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema> {
    const updated = this.rowsModule.update(collection, row, fields);
    this.notifyLocalMutation();
    return updated;
  }

  async getRow<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    return this.rowsModule.getRow(collection, row);
  }

  async openTarget(target: string): Promise<AnyRowHandle<Schema>> {
    const optimisticRow = this.optimisticStore.getRowByTarget(normalizeTarget(target));
    if (optimisticRow) {
      return this.createRuntimeRowHandle(
        optimisticRow.collection as CollectionName<Schema>,
        optimisticRow.row,
        this.optimisticStore.getLogicalFields(optimisticRow.row) ?? {},
      );
    }

    const snapshot = await this.rowRuntime.getRow(target);
    const locator: DbRowLocator = {
      id: snapshot.id,
      owner: snapshot.owner,
      target: normalizeTarget(target),
    };
    const { fields, collection: discoveredCollection } = await this.rowsModule.fetchWithCollection(locator);
    const collection = resolveCollectionName(this.options.schema, discoveredCollection ?? snapshot.collection);
    return this.createRuntimeRowHandle(collection, locator, fields);
  }

  async query<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>>> {
    return this.queryModule.query(collection, options);
  }

  watchQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
    callbacks: DbQueryWatchCallbacks<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>>,
  ): DbQueryWatchHandle {
    return this.queryModule.watchQuery(collection, options, callbacks);
  }

  async getExistingInviteToken(row: DbRowRef): Promise<InviteToken | null> {
    return this.optimisticStore.getInviteToken(row) ?? this.invitesModule.getExistingInviteToken(row);
  }

  createInviteToken(row: DbRowRef): MutationReceipt<InviteToken> {
    const state = this.assertReadyForMutation();
    const inviteToken = this.writePlanner.planInviteToken({
      rowId: row.id,
      invitedBy: state.user.username,
    });
    const receipt = createMutationReceipt(inviteToken);
    this.optimisticStore.setInviteToken(row, inviteToken);
    this.notifyLocalMutation();

    this.scheduleConfirmableWrite({
      key: `invite:${row.owner}:${row.id}`,
      operation: () => this.invitesModule.createInviteTokenRemote(row, inviteToken),
      confirm: () => this.optimisticStore.clearInviteToken(row),
      rollback: () => this.optimisticStore.clearInviteToken(row),
      dependencies: [this.optimisticStore.getPendingCreateDependency(row)].filter((value): value is Promise<unknown> => value !== null),
      receipt,
    });

    return receipt;
  }

  createInviteLink(row: Pick<DbRowLocator, "target">, inviteToken: string): string {
    return this.invitesModule.createInviteLink(row, inviteToken);
  }

  parseInvite(input: string): InviteTarget {
    return this.invitesModule.parseInvite(input);
  }

  async openInvite(input: string | InviteTarget): Promise<AnyRowHandle<Schema>> {
    const invite = typeof input === "string" ? this.parseInvite(input) : input;
    await this.rowRuntime.joinRow(invite.target, {
      inviteToken: invite.inviteToken,
    });
    const row = await this.openTarget(invite.target);
    this.notifyLocalMutation();
    return row;
  }

  async listMembers(row: DbRowLocator): Promise<string[]> {
    const rowRef = toMemberRowRef(row);
    if (this.optimisticStore.getPendingCreateDependency(rowRef)) {
      return Array.from(new Set([
        row.owner,
        ...(this.readyMutationState ? [this.readyMutationState.user.username] : []),
      ]));
    }
    const usernames = await this.rowRuntime.listMembers(row.target);
    const directMembers = await this.listDirectMembers(row);
    return Array.from(new Set([...usernames, ...directMembers.map((member) => member.username)]));
  }

  addParent(child: DbRowRef, parent: DbRowRef): MutationReceipt<void> {
    this.assertReadyForMutation();
    this.optimisticStore.addParent(child, parent);
    const receipt = createMutationReceipt(undefined);
    this.notifyLocalMutation();
    const dependencies = [
      this.optimisticStore.getPendingCreateDependency(child),
      this.optimisticStore.getPendingCreateDependency(parent),
    ].filter((dependency): dependency is Promise<unknown> => dependency !== null);

    this.scheduleConfirmableWrite({
      key: `parent-add:${child.owner}:${child.id}`,
      operation: () => this.parentsModule.addRemote(child, parent),
      confirm: () => this.optimisticStore.confirmParentAdd(child, parent),
      rollback: () => this.optimisticStore.rollbackParentAdd(child, parent),
      dependencies,
      receipt,
    });

    return receipt;
  }

  removeParent(child: DbRowRef, parent: DbRowRef): MutationReceipt<void> {
    this.assertReadyForMutation();
    this.optimisticStore.removeParent(child, parent);
    const receipt = createMutationReceipt(undefined);
    this.notifyLocalMutation();
    this.scheduleConfirmableWrite({
      key: `parent-remove:${child.owner}:${child.id}`,
      operation: () => this.parentsModule.removeRemote(child, parent),
      confirm: () => this.optimisticStore.confirmParentRemove(child, parent),
      rollback: () => this.optimisticStore.rollbackParentRemove(child, parent),
      dependencies: [this.optimisticStore.getPendingCreateDependency(child)].filter((dependency): dependency is Promise<unknown> => dependency !== null),
      receipt,
    });

    return receipt;
  }

  async listParents<TParentCollection extends string>(child: DbRowRef): Promise<Array<DbRowRef<TParentCollection>>> {
    if (this.optimisticStore.getPendingCreateDependency(child)) {
      return this.optimisticStore.getCurrentParents(child, []) as Array<DbRowRef<TParentCollection>>;
    }
    const serverParents = await this.parentsModule.list<TParentCollection>(child);
    this.optimisticStore.recordParents(child, serverParents as DbRowRef[]);
    return this.optimisticStore.getCurrentParents(child, serverParents as DbRowRef[]) as Array<DbRowRef<TParentCollection>>;
  }

  addMember(row: DbRowLocator, username: string, role: MemberRole): MutationReceipt<void> {
    this.assertReadyForMutation();
    const rowRef = toMemberRowRef(row);
    this.optimisticStore.addMember(rowRef, username, role);
    const receipt = createMutationReceipt(undefined);
    this.notifyLocalMutation();
    this.scheduleConfirmableWrite({
      key: `member-add:${row.owner}:${row.id}:${username}`,
      operation: () => this.membersModule.addRemote(row, username, role),
      confirm: () => this.optimisticStore.confirmMemberMutation(rowRef),
      rollback: () => this.optimisticStore.rollbackMemberMutation(rowRef),
      dependencies: [this.optimisticStore.getPendingCreateDependency(rowRef)].filter((dependency): dependency is Promise<unknown> => dependency !== null),
      receipt,
    });

    return receipt;
  }

  removeMember(row: DbRowLocator, username: string): MutationReceipt<void> {
    this.assertReadyForMutation();
    const rowRef = toMemberRowRef(row);
    this.optimisticStore.removeMember(rowRef, username);
    const receipt = createMutationReceipt(undefined);
    this.notifyLocalMutation();
    this.scheduleConfirmableWrite({
      key: `member-remove:${row.owner}:${row.id}:${username}`,
      operation: () => this.membersModule.removeRemote(row, username),
      confirm: () => this.optimisticStore.confirmMemberMutation(rowRef),
      rollback: () => this.optimisticStore.rollbackMemberMutation(rowRef),
      dependencies: [this.optimisticStore.getPendingCreateDependency(rowRef)].filter((dependency): dependency is Promise<unknown> => dependency !== null),
      receipt,
    });

    return receipt;
  }

  async listDirectMembers(row: DbRowLocator): Promise<Array<{ username: string; role: MemberRole }>> {
    const rowRef = toMemberRowRef(row);
    const optimisticDirect = this.optimisticStore.getDirectMembers(rowRef);
    if (optimisticDirect && this.optimisticStore.getPendingCreateDependency(rowRef)) {
      return optimisticDirect;
    }
    const direct = await this.membersModule.listDirect(row);
    this.optimisticStore.recordDirectMembers(rowRef, direct);
    return this.optimisticStore.getDirectMembers(rowRef) ?? direct;
  }

  async listEffectiveMembers(row: DbRowLocator): Promise<Array<DbMemberInfo<Schema>>> {
    const rowRef = toMemberRowRef(row);
    if (this.optimisticStore.getPendingCreateDependency(rowRef)) {
      const direct = this.optimisticStore.getDirectMembers(rowRef) ?? [];
      return direct.map((member) => ({
        username: member.username,
        role: member.role,
        via: "direct",
      })) as Array<DbMemberInfo<Schema>>;
    }
    const effective = await this.membersModule.listEffective(row);
    return this.optimisticStore.getEffectiveMembers(rowRef, effective);
  }

  async refreshFields(row: DbRowLocator): Promise<Record<string, JsonValue>> {
    return this.rowsModule.refreshFields(row);
  }

  connectCrdt(row: DbRowLocator, callbacks: CrdtConnectCallbacks): CrdtConnection {
    return this.syncModule.connectCrdt(row, callbacks);
  }

  subscribeToLocalMutations(listener: LocalMutationListener): () => void {
    this.localMutationListeners.add(listener);
    return () => {
      this.localMutationListeners.delete(listener);
    };
  }

  private syncRuntime(): void {
    const backend = resolveBackend(this.options.backend);
    this.identity.setBackend(backend);
    this.auth.setBackend(backend);
    this.transport.setBackend(backend);
    this.provisioning.setBackend(backend);
  }

  private resetSessionState(): void {
    this.ready = false;
    this.readinessPromise = null;
    this.pendingReadinessError = null;
    this.readyMutationState = null;
    this.rowHandleCache.clear();
    this.identity.clear();
    this.provisioning.reset();
    this.rowRuntime.clearPlannedState();
  }

  private startPrewarmIfSignedIn(): void {
    void this.identity.getSession()
      .then((session) => {
        if (!session.signedIn) {
          return;
        }

        return this.startReadiness();
      })
      .catch(() => undefined);
  }

  private async awaitSharedReadiness(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.pendingReadinessError !== null) {
      const error = this.pendingReadinessError;
      this.pendingReadinessError = null;
      throw error;
    }

    await this.startReadiness();
  }

  private startReadiness(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }

    if (this.readinessPromise) {
      return this.readinessPromise;
    }

    this.syncRuntime();

    const promise = (async () => {
      try {
        const user = await this.identity.whoAmI();
        const prewarmed = await this.provisioning.ensureFederationWorkerForCurrentUser();
        if (!prewarmed) {
          throw new Error(
            missingPuterProvisioningMessage(),
          );
        }

        const federationWorkerUrl = await this.provisioning.getFederationWorkerUrl(user.username);
        this.rowRuntime.setPlannedState({
          user,
          federationWorkerUrl,
        });
        const userScopeRow = this.requiresImplicitUserScope
          ? await this.ensureCurrentUserScopeRow(user.username, true)
          : null;
        this.readyMutationState = {
          user,
          federationWorkerUrl,
          userScopeRow,
        };
        this.ready = true;
        this.pendingReadinessError = null;
      } catch (error) {
        this.ready = false;
        this.pendingReadinessError = error;
        this.readyMutationState = null;
        this.rowRuntime.clearPlannedState();
        throw error;
      }
    })()
      .finally(() => {
        if (this.readinessPromise === promise) {
          this.readinessPromise = null;
        }
      });

    this.readinessPromise = promise;
    return promise;
  }

  private createRuntimeRowHandle<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    locator: DbRowLocator,
    fields: Record<string, JsonValue>,
  ): AnyRowHandle<Schema> {
    return this.materializeRowHandle(collection, locator, fields) as unknown as AnyRowHandle<Schema>;
  }

  private materializeRowHandle<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    locator: DbRowLocator,
    fields: Record<string, JsonValue>,
  ): RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema> {
    const normalizedTarget = normalizeTarget(locator.target);
    const cacheKey = `${collection}:${locator.owner}:${locator.id}:${normalizedTarget}`;
    const snapshot = stableJsonStringify({
      id: locator.id,
      collection,
      owner: locator.owner,
      target: normalizedTarget,
      fields,
    });
    const cached = this.rowHandleCache.get(cacheKey);
    if (cached) {
      const handle = cached.handle as unknown as RowHandle<
        TCollection,
        RowFields<Schema, TCollection>,
        AllowedParentCollections<Schema, TCollection>,
        Schema
      >;
      if (cached.snapshot !== snapshot) {
        handle.fields = fields as RowFields<Schema, TCollection>;
        cached.snapshot = snapshot;
      }
      this.optimisticStore.upsertBaseRow(
        {
          ...locator,
          target: normalizedTarget,
          collection,
        },
        collection,
        fields,
      );
      return handle;
    }

    const rowRef: DbRowRef<TCollection> = {
      ...locator,
      target: normalizedTarget,
      collection,
    };

    const handle = new RowHandle<
      TCollection,
      RowFields<Schema, TCollection>,
      AllowedParentCollections<Schema, TCollection>,
      Schema
    >(
      this,
      rowRef,
      fields as RowFields<Schema, TCollection>,
    );
    this.rowHandleCache.set(cacheKey, {
      handle: handle as unknown as AnyRowHandle<Schema>,
      snapshot,
    });
    this.optimisticStore.upsertBaseRow(rowRef, collection, fields);
    return handle;
  }

  private notifyLocalMutation(): void {
    for (const listener of this.localMutationListeners) {
      try {
        listener();
      } catch {
        // Ignore subscriber failures so local writes still succeed.
      }
    }
  }

  private scheduleConfirmableWrite<TValue>(args: {
    key: string;
    operation: () => Promise<unknown>;
    confirm: () => void;
    rollback: () => void;
    dependencies: Promise<unknown>[];
    receipt: MutableMutationReceipt<TValue>;
  }): void {
    this.writeSettler.schedule(
      args.key,
      async () => {
        try {
          await args.operation();
          args.confirm();
          args.receipt.resolve();
        } catch (error) {
          args.rollback();
          args.receipt.reject(error);
          this.notifyLocalMutation();
          throw error;
        }

        this.notifyLocalMutation();
      },
      args.dependencies,
    ).catch(() => undefined);
  }

  private resolveImplicitPutOptionsSync<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbPutOptions<Schema, TCollection> | undefined,
  ): DbPutOptions<Schema, TCollection> | undefined {
    if (options?.in !== undefined) {
      return options;
    }

    const collectionSpec = getCollectionSpec(this.options.schema, collection);
    if (!hasImplicitUserScope(collectionSpec)) {
      return options;
    }

    const state = this.assertReadyForMutation();
    if (!state.userScopeRow) {
      throw new Error(`Collection ${String(collection)} requires implicit user scope, but the client has no user scope row.`);
    }
    return {
      ...options,
      in: state.userScopeRow,
    } as DbPutOptions<Schema, TCollection>;
  }

  private async resolveImplicitQueryOptions<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<DbQueryOptions<Schema, TCollection>> {
    if (options.in !== undefined) {
      return options;
    }

    const collectionSpec = getCollectionSpec(this.options.schema, collection);
    if (!hasImplicitUserScope(collectionSpec)) {
      return options;
    }

    if (this.readyMutationState?.userScopeRow) {
      return {
        ...options,
        in: this.readyMutationState.userScopeRow,
      } as DbQueryOptions<Schema, TCollection>;
    }

    return {
      ...options,
      in: await this.ensureCurrentUserScopeRow(),
    } as DbQueryOptions<Schema, TCollection>;
  }

  private async ensureCurrentUserScopeRow(
    usernameOverride?: string,
    skipSharedReadiness = false,
  ): Promise<DbRowRef<typeof USER_SCOPE_COLLECTION>> {
    if (!skipSharedReadiness && !this.readyMutationState) {
      await this.awaitSharedReadiness();
    }

    const user = usernameOverride
      ? { username: usernameOverride }
      : await this.identity.whoAmI();
    const backend = resolveBackend(this.options.backend);
    const rememberedRow = await loadRememberedPerUserRow(
      backend,
      user.username,
      INTERNAL_USER_SCOPE_ROW_KEY,
    );

    if (rememberedRow) {
      const remembered = await this.resolveUserScopeRowFromTarget(rememberedRow.target, user.username);
      if (remembered) {
        return remembered;
      }
    }

    const plan = this.rowRuntime.planRow(`${USER_SCOPE_COLLECTION}-scope-${crypto.randomUUID().slice(0, 8)}`);
    const created = await this.rowRuntime.commitPlannedRow(plan);
    const rowRef: DbRowRef<typeof USER_SCOPE_COLLECTION> = {
      id: created.id,
      owner: created.owner,
      target: normalizeTarget(created.target),
      collection: USER_SCOPE_COLLECTION,
    };

    await this.transport.row(rowRef).request("fields/set", {
      fields: {},
      collection: USER_SCOPE_COLLECTION,
    });
    await rememberPerUserRow(backend, user.username, INTERNAL_USER_SCOPE_ROW_KEY, rowRef);
    return rowRef;
  }

  private assertReadyForMutation(): ReadyMutationState {
    if (!this.readyMutationState) {
      throw new Error("PutBase client is not ready. Call ensureReady() before mutating.");
    }

    return this.readyMutationState;
  }

  private async resolveUserScopeRowFromTarget(
    target: string,
    username: string,
  ): Promise<DbRowRef<typeof USER_SCOPE_COLLECTION> | null> {
    try {
      const snapshot = await this.rowRuntime.getRow(target);
      if (snapshot.collection !== USER_SCOPE_COLLECTION || snapshot.owner !== username) {
        return null;
      }

      return {
        id: snapshot.id,
        owner: snapshot.owner,
        target: normalizeTarget(snapshot.target),
        collection: USER_SCOPE_COLLECTION,
      };
    } catch {
      return null;
    }
  }
}

function toMemberRowRef(row: DbRowLocator): DbRowRef {
  const collection = "collection" in row && typeof row.collection === "string"
    ? row.collection
    : "unknown";
  return {
    id: row.id,
    owner: row.owner,
    target: row.target,
    collection,
  };
}
