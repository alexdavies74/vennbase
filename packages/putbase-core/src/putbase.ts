import { AuthManager } from "./auth";
import { Identity } from "./identity";
import { Invites } from "./invites";
import { Members } from "./members";
import { createMutationReceipt, type MutableMutationReceipt, type MutationReceipt } from "./mutation-receipt";
import { OptimisticStore } from "./optimistic-store";
import { Parents } from "./parents";
import {
  clearSavedRow,
  loadSavedRow,
  saveRow,
} from "./saved-rows";
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
  DbCreateArgs,
  DbCreateOptions,
  DbMemberInfo,
  DbQueryOptions,
  DbQueryWatchCallbacks,
  DbQueryWatchHandle,
  DbSchema,
  InsertFields,
  MemberRole,
  RowRef,
  RowInput,
  RowFields,
} from "./schema";
import { resolveBackend } from "./backend";
import { missingPuterProvisioningMessage } from "./errors";
import { BUILTIN_USER_SCOPE as USER_SCOPE_COLLECTION, getCollectionSpec, hasImplicitUserScope, resolveCollectionName } from "./schema";
import { stableJsonStringify } from "./stable-json";
import { Transport } from "./transport";
import type {
  AuthSession,
  BackendClient,
  CrdtConnectCallbacks,
  CrdtConnection,
  DeployWorkerArgs,
  InviteToken,
  JsonValue,
  ParsedInvite,
  PutBaseUser,
} from "./types";
import { Sync } from "./sync";
import { normalizeRowRef, rowRefKey } from "./row-reference";

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
  userScopeRow: RowRef<typeof USER_SCOPE_COLLECTION> | null;
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
      (collection, row, owner, fields) => this.materializeRowHandle(collection, row, owner, fields),
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
      { getRow: (row) => this.rowsModule.getRow(row) },
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

  async saveRow(rowKey: string, row: RowInput): Promise<void> {
    await this.identity.whoAmI();
    await saveRow(resolveBackend(this.options.backend), rowKey, row);
  }

  async openSavedRow(rowKey: string): Promise<AnyRowHandle<Schema> | null> {
    await this.identity.whoAmI();
    const savedRow = await loadSavedRow(resolveBackend(this.options.backend), rowKey);
    if (!savedRow) {
      return null;
    }

    return this.getRow(savedRow as RowRef<CollectionName<Schema>>);
  }

  async clearSavedRow(rowKey: string): Promise<void> {
    await this.identity.whoAmI();
    await clearSavedRow(resolveBackend(this.options.backend), rowKey);
  }

  /**
   * Create a row optimistically and return a mutation receipt immediately.
   * Use `.value` for the row handle and await `.committed` when you need remote confirmation.
   */
  create<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    ...args: DbCreateArgs<Schema, TCollection>
  ): MutationReceipt<RowHandle<Schema, TCollection>> {
    const options = args[0];
    const row = this.rowsModule.create(collection, fields, this.resolveImplicitCreateOptionsSync(collection, options));
    this.notifyLocalMutation();
    return row;
  }

  /**
   * Apply an optimistic field update and return a mutation receipt immediately.
   * Use `.value` for the refreshed row handle and await `.committed` when you need remote confirmation.
   */
  update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: RowInput<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): MutationReceipt<RowHandle<Schema, TCollection>> {
    const updated = this.rowsModule.update(collection, row, fields);
    this.notifyLocalMutation();
    return updated;
  }

  async getRow<TCollection extends CollectionName<Schema>>(
    row: RowInput<TCollection>,
  ): Promise<RowHandle<Schema, TCollection>> {
    return this.rowsModule.getRow(row);
  }

  async query<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<Schema, TCollection>>> {
    return this.queryModule.query(collection, options);
  }

  watchQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
    callbacks: DbQueryWatchCallbacks<RowHandle<Schema, TCollection>>,
  ): DbQueryWatchHandle {
    return this.queryModule.watchQuery(collection, options, callbacks);
  }

  async getExistingInviteToken(row: RowInput): Promise<InviteToken | null> {
    const rowRef = normalizeRowRef(row);
    return this.optimisticStore.getInviteToken(rowRef) ?? this.invitesModule.getExistingInviteToken(rowRef);
  }

  createInviteToken(row: RowInput): MutationReceipt<InviteToken> {
    const state = this.assertReadyForMutation();
    const rowRef = normalizeRowRef(row);
    const inviteToken = this.writePlanner.planInviteToken({
      rowId: rowRef.id,
      invitedBy: state.user.username,
    });
    const receipt = createMutationReceipt(inviteToken);
    this.optimisticStore.setInviteToken(rowRef, inviteToken);
    this.notifyLocalMutation();

    this.scheduleConfirmableWrite({
      key: `invite:${rowRefKey(rowRef)}`,
      operation: () => this.invitesModule.createInviteTokenRemote(rowRef, inviteToken),
      confirm: () => this.optimisticStore.clearInviteToken(rowRef),
      rollback: () => this.optimisticStore.clearInviteToken(rowRef),
      dependencies: [this.optimisticStore.getPendingCreateDependency(rowRef)].filter((value): value is Promise<unknown> => value !== null),
      receipt,
    });

    return receipt;
  }

  createShareLink(row: RowInput, inviteToken: string): string {
    return this.invitesModule.createShareLink(row, inviteToken);
  }

  parseInvite(input: string): ParsedInvite {
    return this.invitesModule.parseInvite(input);
  }

  async acceptInvite(input: string | ParsedInvite): Promise<AnyRowHandle<Schema>> {
    const invite = typeof input === "string" ? this.parseInvite(input) : input;
    await this.rowRuntime.joinRow(invite.ref, {
      inviteToken: invite.inviteToken,
    });
    const row = await this.getRow(invite.ref as RowRef<CollectionName<Schema>>) as AnyRowHandle<Schema>;
    this.notifyLocalMutation();
    return row;
  }

  async listMembers(row: RowInput): Promise<string[]> {
    const rowRef = normalizeRowRef(row);
    if (this.optimisticStore.getPendingCreateDependency(rowRef)) {
      return Array.from(new Set([
        this.optimisticStore.getOwner(rowRef) ?? this.readyMutationState?.user.username ?? "",
        ...(this.readyMutationState ? [this.readyMutationState.user.username] : []),
      ].filter(Boolean)));
    }
    const usernames = await this.rowRuntime.listMembers(rowRef);
    const directMembers = await this.listDirectMembers(row);
    return Array.from(new Set([...usernames, ...directMembers.map((member) => member.username)]));
  }

  addParent(child: RowInput, parent: RowInput): MutationReceipt<void> {
    this.assertReadyForMutation();
    const childRef = normalizeRowRef(child);
    const parentRef = normalizeRowRef(parent);
    this.optimisticStore.addParent(childRef, parentRef);
    const receipt = createMutationReceipt(undefined);
    this.notifyLocalMutation();
    const dependencies = [
      this.optimisticStore.getPendingCreateDependency(childRef),
      this.optimisticStore.getPendingCreateDependency(parentRef),
    ].filter((dependency): dependency is Promise<unknown> => dependency !== null);

    this.scheduleConfirmableWrite({
      key: `parent-add:${rowRefKey(childRef)}`,
      operation: () => this.parentsModule.addRemote(childRef, parentRef),
      confirm: () => this.optimisticStore.confirmParentAdd(childRef, parentRef),
      rollback: () => this.optimisticStore.rollbackParentAdd(childRef, parentRef),
      dependencies,
      receipt,
    });

    return receipt;
  }

  removeParent(child: RowInput, parent: RowInput): MutationReceipt<void> {
    this.assertReadyForMutation();
    const childRef = normalizeRowRef(child);
    const parentRef = normalizeRowRef(parent);
    this.optimisticStore.removeParent(childRef, parentRef);
    const receipt = createMutationReceipt(undefined);
    this.notifyLocalMutation();
    this.scheduleConfirmableWrite({
      key: `parent-remove:${rowRefKey(childRef)}`,
      operation: () => this.parentsModule.removeRemote(childRef, parentRef),
      confirm: () => this.optimisticStore.confirmParentRemove(childRef, parentRef),
      rollback: () => this.optimisticStore.rollbackParentRemove(childRef, parentRef),
      dependencies: [this.optimisticStore.getPendingCreateDependency(childRef)].filter((dependency): dependency is Promise<unknown> => dependency !== null),
      receipt,
    });

    return receipt;
  }

  async listParents<TParentCollection extends string>(child: RowInput): Promise<Array<RowRef<TParentCollection>>> {
    const childRef = normalizeRowRef(child);
    if (this.optimisticStore.getPendingCreateDependency(childRef)) {
      return this.optimisticStore.getCurrentParents(childRef, []) as Array<RowRef<TParentCollection>>;
    }
    const serverParents = await this.parentsModule.list<TParentCollection>(childRef);
    this.optimisticStore.recordParents(childRef, serverParents as RowRef[]);
    return this.optimisticStore.getCurrentParents(childRef, serverParents as RowRef[]) as Array<RowRef<TParentCollection>>;
  }

  addMember(row: RowInput, username: string, role: MemberRole): MutationReceipt<void> {
    this.assertReadyForMutation();
    const rowRef = normalizeRowRef(row);
    this.optimisticStore.addMember(rowRef, username, role);
    const receipt = createMutationReceipt(undefined);
    this.notifyLocalMutation();
    this.scheduleConfirmableWrite({
      key: `member-add:${rowRefKey(rowRef)}:${username}`,
      operation: () => this.membersModule.addRemote(rowRef, username, role),
      confirm: () => this.optimisticStore.confirmMemberMutation(rowRef),
      rollback: () => this.optimisticStore.rollbackMemberMutation(rowRef),
      dependencies: [this.optimisticStore.getPendingCreateDependency(rowRef)].filter((dependency): dependency is Promise<unknown> => dependency !== null),
      receipt,
    });

    return receipt;
  }

  removeMember(row: RowInput, username: string): MutationReceipt<void> {
    this.assertReadyForMutation();
    const rowRef = normalizeRowRef(row);
    this.optimisticStore.removeMember(rowRef, username);
    const receipt = createMutationReceipt(undefined);
    this.notifyLocalMutation();
    this.scheduleConfirmableWrite({
      key: `member-remove:${rowRefKey(rowRef)}:${username}`,
      operation: () => this.membersModule.removeRemote(rowRef, username),
      confirm: () => this.optimisticStore.confirmMemberMutation(rowRef),
      rollback: () => this.optimisticStore.rollbackMemberMutation(rowRef),
      dependencies: [this.optimisticStore.getPendingCreateDependency(rowRef)].filter((dependency): dependency is Promise<unknown> => dependency !== null),
      receipt,
    });

    return receipt;
  }

  async listDirectMembers(row: RowInput): Promise<Array<{ username: string; role: MemberRole }>> {
    const rowRef = normalizeRowRef(row);
    const optimisticDirect = this.optimisticStore.getDirectMembers(rowRef);
    if (optimisticDirect && this.optimisticStore.getPendingCreateDependency(rowRef)) {
      return optimisticDirect;
    }
    const direct = await this.membersModule.listDirect(rowRef);
    this.optimisticStore.recordDirectMembers(rowRef, direct);
    return this.optimisticStore.getDirectMembers(rowRef) ?? direct;
  }

  async listEffectiveMembers(row: RowInput): Promise<Array<DbMemberInfo<Schema>>> {
    const rowRef = normalizeRowRef(row);
    if (this.optimisticStore.getPendingCreateDependency(rowRef)) {
      const direct = this.optimisticStore.getDirectMembers(rowRef) ?? [];
      return direct.map((member) => ({
        username: member.username,
        role: member.role,
        via: "direct",
      })) as Array<DbMemberInfo<Schema>>;
    }
    const effective = await this.membersModule.listEffective(rowRef);
    return this.optimisticStore.getEffectiveMembers(rowRef, effective);
  }

  async refreshFields(row: RowInput): Promise<Record<string, JsonValue>> {
    return this.rowsModule.refreshFields(row);
  }

  connectCrdt(row: RowInput, callbacks: CrdtConnectCallbacks): CrdtConnection {
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
    row: RowRef<TCollection>,
    owner: string,
    fields: Record<string, JsonValue>,
  ): AnyRowHandle<Schema> {
    return this.materializeRowHandle(collection, row, owner, fields) as unknown as AnyRowHandle<Schema>;
  }

  private materializeRowHandle<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: RowRef<TCollection>,
    owner: string,
    fields: Record<string, JsonValue>,
  ): RowHandle<Schema, TCollection> {
    const rowRef = normalizeRowRef(row);
    const cacheKey = `${collection}:${rowRefKey(rowRef)}`;
    const snapshot = stableJsonStringify({
      id: rowRef.id,
      collection,
      owner,
      ref: rowRef,
      fields,
    });
    const cached = this.rowHandleCache.get(cacheKey);
    if (cached) {
      const handle = cached.handle as unknown as RowHandle<Schema, TCollection>;
      if (cached.snapshot !== snapshot) {
        handle.fields = fields as RowFields<Schema, TCollection>;
        cached.snapshot = snapshot;
      }
      this.optimisticStore.upsertBaseRow(rowRef, owner, collection, fields);
      return handle;
    }

    const handle = new RowHandle<
      Schema,
      TCollection,
      RowFields<Schema, TCollection>,
      AllowedParentCollections<Schema, TCollection>
    >(
      this,
      rowRef,
      owner,
      fields as RowFields<Schema, TCollection>,
    );
    this.rowHandleCache.set(cacheKey, {
      handle: handle as unknown as AnyRowHandle<Schema>,
      snapshot,
    });
    this.optimisticStore.upsertBaseRow(rowRef, owner, collection, fields);
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

  private resolveImplicitCreateOptionsSync<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbCreateOptions<Schema, TCollection> | undefined,
  ): DbCreateOptions<Schema, TCollection> | undefined {
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
    } as DbCreateOptions<Schema, TCollection>;
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
  ): Promise<RowRef<typeof USER_SCOPE_COLLECTION>> {
    if (!skipSharedReadiness && !this.readyMutationState) {
      await this.awaitSharedReadiness();
    }

    const user = usernameOverride
      ? { username: usernameOverride }
      : await this.identity.whoAmI();
    const backend = resolveBackend(this.options.backend);
    const rememberedRow = await loadSavedRow(backend, INTERNAL_USER_SCOPE_ROW_KEY);

    if (rememberedRow) {
      const remembered = await this.resolveUserScopeRowFromRef(rememberedRow, user.username);
      if (remembered) {
        return remembered;
      }
    }

    const plan = this.rowRuntime.planRow(`${USER_SCOPE_COLLECTION}-scope-${crypto.randomUUID().slice(0, 8)}`);
    const created = await this.rowRuntime.commitPlannedRow(plan);
    const rowRef: RowRef<typeof USER_SCOPE_COLLECTION> = {
      id: created.id,
      collection: USER_SCOPE_COLLECTION,
      baseUrl: created.baseUrl,
    };

    await this.transport.row(rowRef).request("fields/set", {
      fields: {},
      collection: USER_SCOPE_COLLECTION,
    });
    await saveRow(backend, INTERNAL_USER_SCOPE_ROW_KEY, rowRef);
    return rowRef;
  }

  private assertReadyForMutation(): ReadyMutationState {
    if (!this.readyMutationState) {
      throw new Error("PutBase client is not ready. Call ensureReady() before mutating.");
    }

    return this.readyMutationState;
  }

  private async resolveUserScopeRowFromRef(
    rowRef: RowRef,
    username: string,
  ): Promise<RowRef<typeof USER_SCOPE_COLLECTION> | null> {
    try {
      const snapshot = await this.rowRuntime.getRow(rowRef);
      if (snapshot.collection !== USER_SCOPE_COLLECTION || snapshot.owner !== username) {
        return null;
      }

      return {
        id: snapshot.id,
        collection: USER_SCOPE_COLLECTION,
        baseUrl: snapshot.baseUrl,
      };
    } catch {
      return null;
    }
  }
}
