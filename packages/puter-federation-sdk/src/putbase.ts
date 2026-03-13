import { Identity } from "./identity";
import { Invites } from "./invites";
import { Members } from "./members";
import { Parents } from "./parents";
import { Provisioning } from "./provisioning";
import { Query } from "./query";
import { RowHandle, type RowHandleBackend } from "./row-handle";
import { Rooms } from "./rooms";
import { Rows } from "./rows";
import type {
  AllowedParentCollections,
  CollectionName,
  DbMemberInfo,
  DbPutOptions,
  DbQueryOptions,
  DbQueryWatchCallbacks,
  DbQueryWatchHandle,
  DbRowFields,
  DbRowRef,
  DbSchema,
  InsertFields,
  MemberRole,
  RowFields,
} from "./schema";
import { stripTrailingSlash } from "./transport";
import { Transport } from "./transport";
import type {
  CrdtConnectCallbacks,
  CrdtConnection,
  InviteToken,
  JsonValue,
  ParsedInviteInput,
  PuterFedRoomsOptions,
  RoomUser,
} from "./types";
import { Sync } from "./sync";

export interface PutBaseOptions<Schema extends DbSchema = DbSchema>
  extends PuterFedRoomsOptions {
  schema: Schema;
}

export class PutBase<Schema extends DbSchema = DbSchema> implements RowHandleBackend {
  private readonly transport: Transport;
  private readonly identity: Identity;
  private readonly provisioning: Provisioning;
  private readonly roomsModule: Rooms;
  private readonly invitesModule: Invites;
  private readonly syncModule: Sync;
  private readonly membersModule: Members;
  private readonly parentsModule: Parents;
  private readonly rowsModule: Rows<Schema>;
  private readonly queryModule: Query<Schema>;

  constructor(private readonly options: PutBaseOptions<Schema>) {
    this.identity = new Identity(options);
    this.transport = new Transport(options, () => this.identity.whoAmI().then((u) => u.username));
    this.provisioning = new Provisioning(options, this.transport, this.identity);
    this.roomsModule = new Rooms(this.transport, this.identity, this.provisioning);
    this.invitesModule = new Invites(options, this.transport, this.identity);
    this.syncModule = new Sync(this.roomsModule);
    this.membersModule = new Members(this.transport);
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
    this.queryModule = new Query(this.transport, this.rowsModule, options.schema, this);
  }

  async init(): Promise<void> {
    const puter = this.options.puter ?? (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    this.identity.setPuter(puter);
    this.transport.setPuter(puter);
    this.provisioning.setPuter(puter);

    await this.identity.whoAmI();
    await this.provisioning.init();
  }

  async whoAmI(): Promise<RoomUser> {
    return this.identity.whoAmI();
  }

  async put<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    options?: DbPutOptions<Schema, TCollection>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>>> {
    return this.rowsModule.put(collection, fields, options);
  }

  async update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>>> {
    return this.rowsModule.update(collection, row, fields);
  }

  async getRow<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>>> {
    return this.rowsModule.getRow(collection, row);
  }

  async getRowByUrl(workerUrl: string): Promise<RowHandle<string, DbRowFields>> {
    const snapshot = await this.roomsModule.getRoom(workerUrl);
    const bareRef = {
      id: snapshot.id,
      owner: snapshot.owner,
      workerUrl: stripTrailingSlash(workerUrl),
    };
    const { fields, collection } = await this.rowsModule.fetchWithCollection(bareRef);
    const rowRef: DbRowRef = {
      ...bareRef,
      collection: collection ?? "unknown",
    };
    return new RowHandle(this, rowRef, fields);
  }

  async query<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>>>> {
    return this.queryModule.query(collection, options);
  }

  watchQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
    callbacks: DbQueryWatchCallbacks<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>>>,
  ): DbQueryWatchHandle {
    return this.queryModule.watchQuery(collection, options, callbacks);
  }

  async getExistingInviteToken(row: DbRowRef): Promise<InviteToken | null> {
    return this.invitesModule.getExistingInviteToken(row);
  }

  async createInviteToken(row: DbRowRef): Promise<InviteToken> {
    return this.invitesModule.createInviteToken(row);
  }

  createInviteLink(row: Pick<DbRowRef, "workerUrl">, inviteToken: string): string {
    return this.invitesModule.createInviteLink(row, inviteToken);
  }

  parseInviteInput(input: string): ParsedInviteInput {
    return this.invitesModule.parseInviteInput(input);
  }

  async joinRow(
    workerUrl: string,
    options: { inviteToken?: string } = {},
  ): Promise<RowHandle<string, DbRowFields>> {
    await this.roomsModule.joinRoom(workerUrl, options);
    return this.getRowByUrl(workerUrl);
  }

  async listMembers(row: DbRowRef): Promise<string[]> {
    return this.roomsModule.listMembers(row.workerUrl);
  }

  async addParent(child: DbRowRef, parent: DbRowRef): Promise<void> {
    return this.parentsModule.add(child, parent);
  }

  async removeParent(child: DbRowRef, parent: DbRowRef): Promise<void> {
    return this.parentsModule.remove(child, parent);
  }

  async listParents(child: DbRowRef): Promise<DbRowRef[]> {
    return this.parentsModule.list(child);
  }

  async addMember(row: DbRowRef, username: string, role: MemberRole): Promise<void> {
    return this.membersModule.add(row, username, role);
  }

  async removeMember(row: DbRowRef, username: string): Promise<void> {
    return this.membersModule.remove(row, username);
  }

  async listDirectMembers(row: DbRowRef): Promise<Array<{ username: string; role: MemberRole }>> {
    return this.membersModule.listDirect(row);
  }

  async listEffectiveMembers(row: DbRowRef): Promise<DbMemberInfo[]> {
    return this.membersModule.listEffective(row);
  }

  async refreshFields(row: DbRowRef): Promise<Record<string, JsonValue>> {
    return this.rowsModule.refreshFields(row);
  }

  connectCrdt(row: DbRowRef, callbacks: CrdtConnectCallbacks): CrdtConnection {
    return this.syncModule.connectCrdt(row, callbacks);
  }
}
