import { AuthManager } from "./auth.js";
import { SavedRowCollectionMismatchError } from "./errors.js";
import { Identity } from "./identity.js";
import { Invites } from "./invites.js";
import { Members } from "./members.js";
import { createMutationReceipt, type MutableMutationReceipt, type MutationReceipt } from "./mutation-receipt.js";
import { OptimisticStore } from "./optimistic-store.js";
import { Parents } from "./parents.js";
import {
  clearSavedRow,
  loadSavedRow,
  saveRow,
} from "./saved-rows.js";
import { Provisioning } from "./provisioning.js";
import { Query } from "./query.js";
import { RowHandle, type AnyRowHandle, type RowHandleBackend } from "./row-handle.js";
import { RowRuntime } from "./row-runtime.js";
import { Rows } from "./rows.js";
import { WritePlanner } from "./write-planner.js";
import { WriteSettler } from "./write-settler.js";
import type {
  AllowedParentCollections,
  CollectionName,
  DbCreateArgs,
  DbCreateOptions,
  DbMemberInfo,
  DbQueryOptions,
  DbQueryRows,
  DbQuerySelect,
  InferDbQuerySelect,
  DbQueryWatchCallbacks,
  DbQueryWatchHandle,
  DbSchema,
  InsertFields,
  MemberRole,
  RowRef,
  RowInput,
  RowFields,
} from "./schema.js";
import { resolveBackend } from "./backend.js";
import { BUILTIN_USER_SCOPE as USER_SCOPE_COLLECTION, collectionAllowsCurrentUser, isCurrentUser, resolveCollectionName } from "./schema.js";
import { stableJsonStringify } from "./stable-json.js";
import { Transport } from "./transport.js";
import type {
  AuthSession,
  BackendClient,
  CrdtConnectCallbacks,
  CrdtConnection,
  DeployWorkerArgs,
  JsonValue,
  ParsedInvite,
  ShareToken,
  VennbaseUser,
} from "./types.js";
import { Sync } from "./sync.js";
import { normalizeRowRef, rowRefKey } from "./row-reference.js";
import { canReadContent } from "./member-role.js";

export interface VennbaseOptions<Schema extends DbSchema = DbSchema> {
  schema: Schema;
  backend?: BackendClient;
  fetchFn?: typeof fetch;
  appBaseUrl?: string;
  identityProvider?: () => Promise<VennbaseUser>;
  deployWorker?: (args: DeployWorkerArgs) => Promise<string | void>;
}

interface CachedRowHandle<Schema extends DbSchema> {
  handle: AnyRowHandle<Schema>;
  snapshot: string;
}

interface ReadyMutationState {
  user: VennbaseUser;
  federationWorkerUrl: string;
  userScopeRow: RowRef<typeof USER_SCOPE_COLLECTION> | null;
}

const INTERNAL_USER_SCOPE_ROW_KEY = "__vennbase_user_scope_v1__";
type LocalMutationListener = () => void;

type QueryOptionShape = {
  select?: DbQuerySelect | undefined;
};

type QueryOptionsArg<
  Schema extends DbSchema,
  TCollection extends CollectionName<Schema>,
  TOptions extends QueryOptionShape,
> = TOptions & DbQueryOptions<Schema, TCollection, InferDbQuerySelect<TOptions>>;

export class Vennbase<Schema extends DbSchema = DbSchema> implements RowHandleBackend<Schema> {
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
  private readonly requiresCurrentUserScope: boolean;
  private ready = false;
  private readinessPromise: Promise<void> | null = null;
  private pendingReadinessError: unknown | null = null;
  private readyMutationState: ReadyMutationState | null = null;
  private readonly rowHandleCache = new Map<string, CachedRowHandle<Schema>>();
  private readonly localMutationListeners = new Set<LocalMutationListener>();

  constructor(private readonly options: VennbaseOptions<Schema>) {
    this.identity = new Identity(options);
    this.auth = new AuthManager(resolveBackend(options.backend), () => this.identity.whoAmI().then((u) => u.username));
    this.transport = new Transport(options, this.auth);
    this.provisioning = new Provisioning(options, this.transport, this.auth);
    this.syncRuntime();
    this.writePlanner = new WritePlanner(this.transport);
    this.requiresCurrentUserScope = Object.values(options.schema).some((collectionSpec) => collectionAllowsCurrentUser(collectionSpec));
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
      () => this.ensureCurrentUserScopeRow(),
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
      {
        getRow: (row) => this.rowsModule.getRow(row),
        peekRow: (row) => this.peekCachedRow(row),
      },
      this.optimisticStore,
      options.schema,
      (collection, queryOptions) => this.resolveCurrentUserQueryOptions(collection, queryOptions),
      (collection, queryOptions) => this.resolveCurrentUserQueryOptionsSync(collection, queryOptions),
    );
    this.startPrewarmIfSignedIn();
  }

  async getSession(): Promise<AuthSession> {
    let session = await this.identity.getSession();
    if (!session.signedIn && !this.options.backend && resolveBackend()) {
      this.identity.clear();
      session = await this.identity.getSession();
    }

    if (!session.signedIn) {
      return session;
    }

    await this.awaitSharedReadiness();
    return session;
  }

  async signIn(): Promise<VennbaseUser> {
    this.resetSessionState();
    const user = await this.identity.signIn();
    await this.awaitSharedReadiness();
    this.notifyLocalMutation();
    return user;
  }

  async whoAmI(): Promise<VennbaseUser> {
    return this.identity.whoAmI();
  }

  async saveRow(rowKey: string, row: RowInput): Promise<void> {
    await this.identity.whoAmI();
    await saveRow(resolveBackend(this.options.backend), rowKey, row);
    this.notifyLocalMutation();
  }

  async openSavedRow<TCollection extends CollectionName<Schema>>(
    rowKey: string,
    collection: TCollection,
  ): Promise<RowHandle<Schema, TCollection> | null> {
    await this.identity.whoAmI();
    const savedRow = await loadSavedRow(resolveBackend(this.options.backend), rowKey);
    if (!savedRow) {
      return null;
    }

    if (savedRow.collection !== collection) {
      throw new SavedRowCollectionMismatchError(rowKey, collection, savedRow.collection);
    }

    return this.getRow(savedRow as RowRef<TCollection>);
  }

  async clearSavedRow(rowKey: string): Promise<void> {
    await this.identity.whoAmI();
    await clearSavedRow(resolveBackend(this.options.backend), rowKey);
    this.notifyLocalMutation();
  }

  /**
   * Create a row optimistically and return a mutation receipt immediately.
   * Use `.value` for the row handle immediately. `.committed` resolves once the server confirms the write — only needed for cross-session flows.
   */
  create<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    ...args: DbCreateArgs<Schema, TCollection>
  ): MutationReceipt<RowHandle<Schema, TCollection>> {
    const options = args[0];
    return this.rowsModule.create(collection, fields, this.resolveCurrentUserCreateOptionsSync(collection, options));
  }

  /**
   * Apply an optimistic field update and return a mutation receipt immediately.
   * Use `.value` for the refreshed row handle immediately. `.committed` resolves once the server confirms the write — only needed for cross-session flows.
   */
  update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: RowInput<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): MutationReceipt<RowHandle<Schema, TCollection>> {
    return this.rowsModule.update(collection, row, fields);
  }

  async getRow<TCollection extends CollectionName<Schema>>(
    row: RowInput<TCollection>,
  ): Promise<RowHandle<Schema, TCollection>> {
    return this.rowsModule.getRow(row);
  }

  async query<
    TCollection extends CollectionName<Schema>,
    TOptions extends QueryOptionShape = DbQueryOptions<Schema, TCollection, "full">,
  >(
    collection: TCollection,
    options: QueryOptionsArg<Schema, TCollection, TOptions>,
  ): Promise<DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>> {
    return this.queryModule.query(collection, options);
  }

  /** @internal Use peekQuery only via the React runtime. Returns local optimistic state only — no transport call. */
  peekQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection, "full">,
  ): Array<RowHandle<Schema, TCollection>> {
    return this.queryModule.peekQuery(collection, options);
  }

  watchQuery<
    TCollection extends CollectionName<Schema>,
    TOptions extends QueryOptionShape = DbQueryOptions<Schema, TCollection, "full">,
  >(
    collection: TCollection,
    options: QueryOptionsArg<Schema, TCollection, TOptions>,
    callbacks: DbQueryWatchCallbacks<DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>[number]>,
  ): DbQueryWatchHandle {
    return this.queryModule.watchQuery(collection, options, callbacks);
  }

  async getExistingShareToken(row: RowInput, role: MemberRole): Promise<ShareToken | null> {
    const rowRef = normalizeRowRef(row);
    return this.optimisticStore.getShareToken(rowRef, role)
      ?? this.invitesModule.getExistingShareToken(rowRef, role);
  }

  /**
   * Optimistically mint a share token locally and enqueue the remote invite-token write.
   * Use `.value` for local follow-up work immediately. Await `.committed` before another
   * client must be able to consume the token.
   */
  createShareToken(row: RowInput, role: MemberRole): MutationReceipt<ShareToken> {
    const state = this.assertReadyForMutation();
    const rowRef = normalizeRowRef(row);
    const shareToken = this.writePlanner.planShareToken({
      rowId: rowRef.id,
      invitedBy: state.user.username,
      role,
    });
    const receipt = createMutationReceipt(shareToken);
    this.optimisticStore.setShareToken(rowRef, shareToken);
    this.notifyLocalMutation();

    this.scheduleConfirmableWrite({
      key: `invite:${rowRefKey(rowRef)}`,
      operation: () => this.invitesModule.createShareTokenRemote(rowRef, shareToken),
      confirm: () => this.optimisticStore.clearShareToken(rowRef, shareToken.role),
      rollback: () => this.optimisticStore.clearShareToken(rowRef, shareToken.role),
      dependencies: [this.optimisticStore.getPendingCreateDependency(rowRef)].filter((value): value is Promise<unknown> => value !== null),
      receipt,
    });

    return receipt;
  }

  createShareLink(row: RowInput, role: MemberRole): MutationReceipt<string>;
  createShareLink(row: RowInput, shareToken: ShareToken): string;
  
  /**
   * `createShareLink(row, shareToken)` is a pure local serializer.
   * `createShareLink(row, role)` returns a future-valid link immediately and resolves once
   * the invite token exists remotely.
   */
  createShareLink(row: RowInput, roleOrShareToken: MemberRole | ShareToken): MutationReceipt<string> | string {
    if (typeof roleOrShareToken !== "string") {
      return this.invitesModule.createShareLink(row, roleOrShareToken.token);
    }

    const shareTokenReceipt = this.createShareToken(row, roleOrShareToken);
    const shareLink = this.invitesModule.createShareLink(row, shareTokenReceipt.value.token);
    const receipt = createMutationReceipt(shareLink);
    shareTokenReceipt.committed
      .then(() => {
        receipt.resolve(shareLink);
      })
      .catch((error) => {
        receipt.reject(error);
      });
    return receipt;
  }

  parseInvite(input: string): ParsedInvite {
    return this.invitesModule.parseInvite(input);
  }

  async joinInvite(input: string | ParsedInvite): Promise<{ ref: RowRef; role: MemberRole }> {
    const invite = typeof input === "string" ? this.parseInvite(input) : input;
    const role = await this.rowRuntime.joinMembership(invite.ref, {
      inviteToken: invite.shareToken,
    });

    return {
      ref: invite.ref,
      role,
    };
  }

  async acceptInvite(input: string | ParsedInvite): Promise<AnyRowHandle<Schema>> {
    const joined = await this.joinInvite(input);
    if (!canReadContent([joined.role])) {
      throw new Error("This invite grants join-only access. Use joinInvite() instead of acceptInvite().");
    }

    const row = await this.getRow(joined.ref as RowRef<CollectionName<Schema>>) as AnyRowHandle<Schema>;
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
    const directMembers = await this.listDirectMembers(row);
    return Array.from(new Set(directMembers.map((member) => member.username)));
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
        roles: [member.role],
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
        const federationWorkerUrl = await this.provisioning.getUsableFederationWorkerUrl(user.username);
        this.rowRuntime.setPlannedState({
          user,
          federationWorkerUrl,
        });
        const userScopeRow = this.requiresCurrentUserScope
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

  private peekCachedRow<TCollection extends CollectionName<Schema>>(
    row: RowRef<TCollection>,
  ): RowHandle<Schema, TCollection> | null {
    const rowRef = normalizeRowRef(row);
    const fields = this.optimisticStore.getLogicalFields(rowRef);
    const owner = this.optimisticStore.getOwner(rowRef);
    if (!fields || !owner) {
      return null;
    }

    const collection = rowRef.collection as TCollection;
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

  private resolveCurrentUserCreateOptionsSync<TCollection extends CollectionName<Schema>>(
    _collection: TCollection,
    options: DbCreateOptions<Schema, TCollection> | undefined,
  ): DbCreateOptions<Schema, TCollection> | undefined {
    if (options?.in === undefined) {
      return options;
    }

    return {
      ...options,
      in: this.resolveCurrentUserParentInputSync(options.in),
    } as DbCreateOptions<Schema, TCollection>;
  }

  private async resolveCurrentUserQueryOptions<
    TCollection extends CollectionName<Schema>,
    TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
  >(
    _collection: TCollection,
    options: TOptions,
  ): Promise<TOptions> {
    if (options.in === undefined) {
      return options;
    }

    return {
      ...options,
      in: await this.resolveCurrentUserParentInput(options.in),
    } as TOptions;
  }

  private resolveCurrentUserQueryOptionsSync<
    TCollection extends CollectionName<Schema>,
    TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
  >(
    _collection: TCollection,
    options: TOptions,
  ): TOptions {
    if (options.in === undefined) {
      return options;
    }

    return {
      ...options,
      in: this.resolveCurrentUserParentInputSync(options.in),
    } as TOptions;
  }

  private resolveCurrentUserParentInputSync<TParentInput>(input: TParentInput): TParentInput {
    if (Array.isArray(input)) {
      return input.map((parent) => this.resolveCurrentUserParentSync(parent)) as TParentInput;
    }

    return this.resolveCurrentUserParentSync(input) as TParentInput;
  }

  private async resolveCurrentUserParentInput<TParentInput>(input: TParentInput): Promise<TParentInput> {
    if (Array.isArray(input)) {
      return Promise.all(input.map((parent) => this.resolveCurrentUserParent(parent))) as Promise<TParentInput>;
    }

    return this.resolveCurrentUserParent(input) as Promise<TParentInput>;
  }

  private resolveCurrentUserParentSync<TParentInput>(input: TParentInput): TParentInput | RowRef<typeof USER_SCOPE_COLLECTION> {
    if (!isCurrentUser(input)) {
      return input;
    }

    if (this.readyMutationState?.userScopeRow) {
      return this.readyMutationState.userScopeRow;
    }

    return input;
  }

  private async resolveCurrentUserParent<TParentInput>(input: TParentInput): Promise<TParentInput | RowRef<typeof USER_SCOPE_COLLECTION>> {
    if (!isCurrentUser(input)) {
      return input;
    }

    if (this.readyMutationState?.userScopeRow) {
      return this.readyMutationState.userScopeRow;
    }

    return this.ensureCurrentUserScopeRow();
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
        if (this.readyMutationState?.user.username === user.username) {
          this.readyMutationState.userScopeRow = remembered;
        }
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
    if (this.readyMutationState?.user.username === user.username) {
      this.readyMutationState.userScopeRow = rowRef;
    }
    return rowRef;
  }

  private assertReadyForMutation(): ReadyMutationState {
    if (!this.readyMutationState) {
      throw new Error("Vennbase client is not ready for synchronous mutations.");
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
