import { AuthManager } from "./auth";
import { Identity } from "./identity";
import { Invites } from "./invites";
import { Members } from "./members";
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

const INTERNAL_USER_SCOPE_ROW_KEY = "__putbase_user_scope_v1__";
type LocalMutationListener = () => void;

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
  private ready = false;
  private readinessPromise: Promise<void> | null = null;
  private pendingReadinessError: unknown | null = null;
  private readonly rowHandleCache = new Map<string, CachedRowHandle<Schema>>();
  private readonly localMutationListeners = new Set<LocalMutationListener>();

  constructor(private readonly options: PutBaseOptions<Schema>) {
    this.identity = new Identity(options);
    this.auth = new AuthManager(resolveBackend(options.backend), () => this.identity.whoAmI().then((u) => u.username));
    this.transport = new Transport(options, this.auth);
    this.provisioning = new Provisioning(options, this.transport, this.identity, this.auth);
    this.syncRuntime();
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
      (collection, row, fields) => this.materializeRowHandle(collection, row, fields),
      (child, parent) => this.parentsModule.add(child, parent),
    );
    this.parentsModule = new Parents(
      this.transport,
      this.rowRuntime,
      options.schema,
      (row) => this.rowsModule.refreshFields(row),
    );
    this.queryModule = new Query(
      this.transport,
      this.rowsModule,
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

  async put<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    ...args: DbPutArgs<Schema, TCollection>
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    const options = args[0];
    const row = await this.rowsModule.put(collection, fields, await this.resolveImplicitPutOptions(collection, options));
    this.notifyLocalMutation();
    return row;
  }

  async update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    const updated = await this.rowsModule.update(collection, row, fields);
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
    return this.invitesModule.getExistingInviteToken(row);
  }

  async createInviteToken(row: DbRowRef): Promise<InviteToken> {
    return this.invitesModule.createInviteToken(row);
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
    return this.rowRuntime.listMembers(row.target);
  }

  async addParent(child: DbRowRef, parent: DbRowRef): Promise<void> {
    await this.parentsModule.add(child, parent);
    this.notifyLocalMutation();
  }

  async removeParent(child: DbRowRef, parent: DbRowRef): Promise<void> {
    await this.parentsModule.remove(child, parent);
    this.notifyLocalMutation();
  }

  async listParents<TParentCollection extends string>(child: DbRowRef): Promise<Array<DbRowRef<TParentCollection>>> {
    return this.parentsModule.list<TParentCollection>(child);
  }

  async addMember(row: DbRowLocator, username: string, role: MemberRole): Promise<void> {
    await this.membersModule.add(row, username, role);
    this.notifyLocalMutation();
  }

  async removeMember(row: DbRowLocator, username: string): Promise<void> {
    await this.membersModule.remove(row, username);
    this.notifyLocalMutation();
  }

  async listDirectMembers(row: DbRowLocator): Promise<Array<{ username: string; role: MemberRole }>> {
    return this.membersModule.listDirect(row);
  }

  async listEffectiveMembers(row: DbRowLocator): Promise<Array<DbMemberInfo<Schema>>> {
    return this.membersModule.listEffective(row);
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
    this.rowHandleCache.clear();
    this.identity.clear();
    this.provisioning.reset();
  }

  private startPrewarmIfSignedIn(): void {
    void this.identity.getSession()
      .then((session) => {
        if (session.state !== "signed-in") {
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
        await this.identity.whoAmI();

        const prewarmed = await this.provisioning.ensureFederationWorkerForCurrentUser();
        if (!prewarmed) {
          throw new Error(
            missingPuterProvisioningMessage(),
          );
        }

        this.ready = true;
        this.pendingReadinessError = null;
      } catch (error) {
        this.ready = false;
        this.pendingReadinessError = error;
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

  private async resolveImplicitPutOptions<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbPutOptions<Schema, TCollection> | undefined,
  ): Promise<DbPutOptions<Schema, TCollection> | undefined> {
    if (options?.in !== undefined) {
      return options;
    }

    const collectionSpec = getCollectionSpec(this.options.schema, collection);
    if (!hasImplicitUserScope(collectionSpec)) {
      return options;
    }

    return {
      ...options,
      in: await this.ensureCurrentUserScopeRow(),
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

    return {
      ...options,
      in: await this.ensureCurrentUserScopeRow(),
    } as DbQueryOptions<Schema, TCollection>;
  }

  private async ensureCurrentUserScopeRow(): Promise<DbRowRef<typeof USER_SCOPE_COLLECTION>> {
    const user = await this.identity.whoAmI();
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

    const created = await this.rowRuntime.createRow(`${USER_SCOPE_COLLECTION}-scope-${crypto.randomUUID().slice(0, 8)}`);
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
