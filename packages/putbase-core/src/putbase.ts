import { AuthManager } from "./auth";
import { Identity } from "./identity";
import { Invites } from "./invites";
import { Members } from "./members";
import { Parents } from "./parents";
import { Provisioning } from "./provisioning";
import { Query } from "./query";
import { RowHandle, type AnyRowHandle, type RowHandleBackend } from "./row-handle";
import { RowRuntime } from "./row-runtime";
import { Rows } from "./rows";
import type {
  AllowedParentCollections,
  CollectionName,
  DbMemberInfo,
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
import { resolveCollectionName } from "./schema";
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
      this,
      (child, parent) => this.parentsModule.add(child, parent),
    );
    this.parentsModule = new Parents(
      this.transport,
      this.rowRuntime,
      options.schema,
      (row) => this.rowsModule.refreshFields(row),
    );
    this.queryModule = new Query(this.transport, this.rowsModule, options.schema);
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

  async put<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    options?: DbPutOptions<Schema, TCollection>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    return this.rowsModule.put(collection, fields, options);
  }

  async update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    return this.rowsModule.update(collection, row, fields);
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
    return this.openTarget(invite.target);
  }

  async listMembers(row: DbRowLocator): Promise<string[]> {
    return this.rowRuntime.listMembers(row.target);
  }

  async addParent(child: DbRowRef, parent: DbRowRef): Promise<void> {
    return this.parentsModule.add(child, parent);
  }

  async removeParent(child: DbRowRef, parent: DbRowRef): Promise<void> {
    return this.parentsModule.remove(child, parent);
  }

  async listParents<TParentCollection extends string>(child: DbRowRef): Promise<Array<DbRowRef<TParentCollection>>> {
    return this.parentsModule.list<TParentCollection>(child);
  }

  async addMember(row: DbRowLocator, username: string, role: MemberRole): Promise<void> {
    return this.membersModule.add(row, username, role);
  }

  async removeMember(row: DbRowLocator, username: string): Promise<void> {
    return this.membersModule.remove(row, username);
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
      while (true) {
        try {
          await this.identity.whoAmI();

          const prewarmed = await this.provisioning.ensureFederationWorkerForCurrentUser();
          if (!prewarmed) {
            if (await this.waitForAmbientProvisioningBackend()) {
              continue;
            }

            throw new Error(
              missingPuterProvisioningMessage(),
            );
          }

          this.ready = true;
          this.pendingReadinessError = null;
          return;
        } catch (error) {
          if (this.shouldWaitForAmbientProvisioningBackend(error)) {
            const waited = await this.waitForAmbientProvisioningBackend();
            if (waited) {
              continue;
            }
          }

          this.ready = false;
          this.pendingReadinessError = error;
          throw error;
        }
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

  private shouldWaitForAmbientProvisioningBackend(error: unknown): boolean {
    if (this.options.backend || this.options.deployWorker || !this.options.appBaseUrl) {
      return false;
    }

    if (resolveBackend() !== undefined) {
      return false;
    }

    if (!error || typeof error !== "object" || !("code" in error)) {
      return false;
    }

    return (error as { code?: unknown }).code === "SIGNED_OUT";
  }

  private async waitForAmbientProvisioningBackend(): Promise<boolean> {
    if (this.options.backend || this.options.deployWorker || !this.options.appBaseUrl) {
      return this.provisioning.canDeployFederationWorker();
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      this.syncRuntime();
      if (this.provisioning.canDeployFederationWorker()) {
        return true;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    this.syncRuntime();
    return this.provisioning.canDeployFederationWorker();
  }

  private createRuntimeRowHandle<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    locator: DbRowLocator,
    fields: Record<string, JsonValue>,
  ): AnyRowHandle<Schema> {
    const rowRef: DbRowRef<TCollection> = {
      ...locator,
      collection,
    };

    return new RowHandle<
      TCollection,
      RowFields<Schema, TCollection>,
      AllowedParentCollections<Schema, TCollection>,
      Schema
    >(
      this,
      rowRef,
      fields as RowFields<Schema, TCollection>,
    ) as unknown as AnyRowHandle<Schema>;
  }
}
