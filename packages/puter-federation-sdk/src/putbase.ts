import { Identity } from "./identity";
import { Invites } from "./invites";
import { Members } from "./members";
import { Parents } from "./parents";
import { Provisioning } from "./provisioning";
import { Query } from "./query";
import { RowHandle, type AnyRowHandle, type RowHandleBackend } from "./row-handle";
import { Rooms } from "./rooms";
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
import { resolveCollectionName } from "./schema";
import { stripTrailingSlash } from "./transport";
import { Transport } from "./transport";
import type {
  BackendClient,
  CrdtConnectCallbacks,
  CrdtConnection,
  DeployWorkerArgs,
  InviteToken,
  JsonValue,
  ParsedInviteInput,
  RoomUser,
} from "./types";
import { Sync } from "./sync";

export interface PutBaseOptions<Schema extends DbSchema = DbSchema> {
  schema: Schema;
  backend?: BackendClient;
  fetchFn?: typeof fetch;
  appBaseUrl?: string;
  identityProvider?: () => Promise<RoomUser>;
  deployWorker?: (args: DeployWorkerArgs) => Promise<string | void>;
}

export class PutBase<Schema extends DbSchema = DbSchema> implements RowHandleBackend<Schema> {
  private readonly transport: Transport;
  private readonly identity: Identity;
  private readonly provisioning: Provisioning;
  private readonly roomsModule: Rooms;
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
    this.transport = new Transport(options, () => this.identity.whoAmI().then((u) => u.username));
    this.provisioning = new Provisioning(options, this.transport, this.identity);
    this.syncRuntime();
    this.roomsModule = new Rooms(
      this.transport,
      this.identity,
      this.provisioning,
      () => this.awaitSharedReadiness(),
    );
    this.invitesModule = new Invites(options, this.transport, this.identity);
    this.syncModule = new Sync(this.roomsModule);
    this.membersModule = new Members<Schema>(this.transport);
    this.rowsModule = new Rows(
      this.transport,
      this.roomsModule,
      options.schema,
      this,
      (child, parent) => this.parentsModule.add(child, parent),
    );
    this.parentsModule = new Parents(
      this.transport,
      this.roomsModule,
      options.schema,
      (row) => this.rowsModule.refreshFields(row),
    );
    this.queryModule = new Query(this.transport, this.rowsModule, options.schema);
    this.startPrewarm();
  }

  async ensureReady(): Promise<void> {
    await this.awaitSharedReadiness();
  }

  async whoAmI(): Promise<RoomUser> {
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

  async getRowByUrl(workerUrl: string): Promise<AnyRowHandle<Schema>> {
    const snapshot = await this.roomsModule.getRoom(workerUrl);
    const locator: DbRowLocator = {
      id: snapshot.id,
      owner: snapshot.owner,
      workerUrl: stripTrailingSlash(workerUrl),
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

  createInviteLink(row: Pick<DbRowLocator, "workerUrl">, inviteToken: string): string {
    return this.invitesModule.createInviteLink(row, inviteToken);
  }

  parseInviteInput(input: string): ParsedInviteInput {
    return this.invitesModule.parseInviteInput(input);
  }

  async joinRow(
    workerUrl: string,
    options: { inviteToken?: string } = {},
  ): Promise<AnyRowHandle<Schema>> {
    await this.roomsModule.joinRoom(workerUrl, options);
    return this.getRowByUrl(workerUrl);
  }

  async listMembers(row: DbRowLocator): Promise<string[]> {
    return this.roomsModule.listMembers(row.workerUrl);
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
    this.transport.setBackend(backend);
    this.provisioning.setBackend(backend);
  }

  private startPrewarm(): void {
    void this.startReadiness().catch(() => undefined);
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
              "Unable to provision federation worker: a compatible backend with workers.create is unavailable.",
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

    if (!error || typeof error !== "object" || !("message" in error)) {
      return false;
    }

    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.includes("Unable to determine the current username");
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
