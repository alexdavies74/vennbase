import type { CrdtConnectCallbacks, CrdtConnection, JsonValue } from "./types";
import type { MutationReceipt } from "./mutation-receipt";
import type {
  AllowedParentCollections,
  CollectionName,
  DbMemberInfo,
  DbRowFields,
  DbSchema,
  MemberRole,
  RowRef,
  RowFields,
} from "./schema";

export interface RowHandleBackend<Schema extends DbSchema = DbSchema> {
  addParent(child: RowRef, parent: RowRef): MutationReceipt<void>;
  removeParent(child: RowRef, parent: RowRef): MutationReceipt<void>;
  listParents<TParentCollection extends string>(child: RowRef): Promise<Array<RowRef<TParentCollection>>>;
  addMember(row: RowRef, username: string, role: MemberRole): MutationReceipt<void>;
  removeMember(row: RowRef, username: string): MutationReceipt<void>;
  listDirectMembers(row: RowRef): Promise<Array<{ username: string; role: MemberRole }>>;
  listEffectiveMembers(row: RowRef): Promise<Array<DbMemberInfo<Schema>>>;
  refreshFields(row: RowRef): Promise<Record<string, JsonValue>>;
  connectCrdt(row: RowRef, callbacks: CrdtConnectCallbacks): CrdtConnection;
  listMembers(row: RowRef): Promise<string[]>;
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

  readonly ref: RowRef<TCollection>;

  fields: TFields;
  settled: Promise<this>;

  readonly in: {
    add: (parent: RowRef<TAllowedParentCollections>) => MutationReceipt<void>;
    remove: (parent: RowRef<TAllowedParentCollections>) => MutationReceipt<void>;
    list: () => Promise<Array<RowRef<TAllowedParentCollections>>>;
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
    row: RowRef<TCollection>,
    owner: string,
    fields: TFields,
  ) {
    this.id = row.id;
    this.collection = row.collection;
    this.owner = owner;
    this.ref = row;
    this.fields = fields;
    this.settled = Promise.resolve(this);

    this.in = {
      add: (parent: RowRef<TAllowedParentCollections>) => this.backend.addParent(this.ref, parent),
      remove: (parent: RowRef<TAllowedParentCollections>) => this.backend.removeParent(this.ref, parent),
      list: async () => this.backend.listParents<TAllowedParentCollections>(this.ref),
    };

    this.members = {
      add: (username: string, options: { role: MemberRole }) => this.backend.addMember(this.ref, username, options.role),
      remove: (username: string) => this.backend.removeMember(this.ref, username),
      list: async () => this.backend.listDirectMembers(this.ref),
      effective: async () => this.backend.listEffectiveMembers(this.ref),
      listAll: async () => this.backend.listMembers(this.ref),
    };
  }

  connectCrdt(callbacks: CrdtConnectCallbacks): CrdtConnection {
    return this.backend.connectCrdt(this.ref, callbacks);
  }

  async refresh(): Promise<TFields> {
    this.fields = await this.backend.refreshFields(this.ref) as TFields;
    return this.fields;
  }

  attachSettlement(receipt: Pick<MutationReceipt<unknown>, "settled">): this {
    this.settled = receipt.settled.then(() => this);
    return this;
  }
}
