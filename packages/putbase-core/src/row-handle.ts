import type { CrdtConnectCallbacks, CrdtConnection, JsonValue } from "./types";
import type { MutationReceipt } from "./mutation-receipt";
import type {
  AllowedParentCollections,
  CollectionName,
  DbMemberInfo,
  DbRowFields,
  DbRowLocator,
  DbRowRef,
  DbSchema,
  MemberRole,
  RowFields,
} from "./schema";

export interface RowHandleBackend<Schema extends DbSchema = DbSchema> {
  addParent(child: DbRowRef, parent: DbRowRef): MutationReceipt<void>;
  removeParent(child: DbRowRef, parent: DbRowRef): MutationReceipt<void>;
  listParents<TParentCollection extends string>(child: DbRowRef): Promise<Array<DbRowRef<TParentCollection>>>;
  addMember(row: DbRowLocator, username: string, role: MemberRole): MutationReceipt<void>;
  removeMember(row: DbRowLocator, username: string): MutationReceipt<void>;
  listDirectMembers(row: DbRowLocator): Promise<Array<{ username: string; role: MemberRole }>>;
  listEffectiveMembers(row: DbRowLocator): Promise<Array<DbMemberInfo<Schema>>>;
  refreshFields(row: DbRowLocator): Promise<Record<string, JsonValue>>;
  connectCrdt(row: DbRowLocator, callbacks: CrdtConnectCallbacks): CrdtConnection;
  listMembers(row: DbRowLocator): Promise<string[]>;
}

export type AnyRowHandle<Schema extends DbSchema> = {
  [TCollection in CollectionName<Schema>]: RowHandle<
    TCollection,
    RowFields<Schema, TCollection>,
    AllowedParentCollections<Schema, TCollection>,
    Schema
  >;
}[CollectionName<Schema>];

export class RowHandle<
  TCollection extends string = string,
  TFields extends DbRowFields = DbRowFields,
  TAllowedParentCollections extends string = string,
  TSchema extends DbSchema = DbSchema,
> {
  readonly id: string;

  readonly collection: TCollection;

  readonly owner: string;

  readonly target: string;

  fields: TFields;
  settled: Promise<this>;

  readonly in: {
    add: (parent: DbRowRef<TAllowedParentCollections>) => MutationReceipt<void>;
    remove: (parent: DbRowRef<TAllowedParentCollections>) => MutationReceipt<void>;
    list: () => Promise<Array<DbRowRef<TAllowedParentCollections>>>;
  };

  readonly members: {
    add: (username: string, options: { role: MemberRole }) => MutationReceipt<void>;
    remove: (username: string) => MutationReceipt<void>;
    list: () => Promise<Array<{ username: string; role: MemberRole }>>;
    effective: () => Promise<Array<DbMemberInfo<TSchema>>>;
    listAll: () => Promise<string[]>;
  };

  constructor(
    private readonly backend: RowHandleBackend<TSchema>,
    row: DbRowRef<TCollection>,
    fields: TFields,
  ) {
    this.id = row.id;
    this.collection = row.collection;
    this.owner = row.owner;
    this.target = row.target;
    this.fields = fields;
    this.settled = Promise.resolve(this);

    this.in = {
      add: (parent: DbRowRef<TAllowedParentCollections>) => this.backend.addParent(this.toRef(), parent),
      remove: (parent: DbRowRef<TAllowedParentCollections>) => this.backend.removeParent(this.toRef(), parent),
      list: async () => this.backend.listParents<TAllowedParentCollections>(this.toRef()),
    };

    this.members = {
      add: (username: string, options: { role: MemberRole }) => this.backend.addMember(this.toRef(), username, options.role),
      remove: (username: string) => this.backend.removeMember(this.toRef(), username),
      list: async () => this.backend.listDirectMembers(this.toRef()),
      effective: async () => this.backend.listEffectiveMembers(this.toRef()),
      listAll: async () => this.backend.listMembers(this.toRef()),
    };
  }

  connectCrdt(callbacks: CrdtConnectCallbacks): CrdtConnection {
    return this.backend.connectCrdt(this.toRef(), callbacks);
  }

  async refresh(): Promise<TFields> {
    this.fields = await this.backend.refreshFields(this.toRef()) as TFields;
    return this.fields;
  }

  attachSettlement(receipt: Pick<MutationReceipt<unknown>, "settled">): this {
    this.settled = receipt.settled.then(() => this);
    return this;
  }

  toRef(): DbRowRef<TCollection> {
    return {
      id: this.id,
      collection: this.collection,
      owner: this.owner,
      target: this.target,
    };
  }
}
