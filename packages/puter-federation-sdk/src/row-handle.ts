import type { CrdtConnectCallbacks, CrdtConnection, JsonValue } from "./types";
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
  addParent(child: DbRowRef, parent: DbRowRef): Promise<void>;
  removeParent(child: DbRowRef, parent: DbRowRef): Promise<void>;
  listParents<TParentCollection extends string>(child: DbRowRef): Promise<Array<DbRowRef<TParentCollection>>>;
  addMember(row: DbRowLocator, username: string, role: MemberRole): Promise<void>;
  removeMember(row: DbRowLocator, username: string): Promise<void>;
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

  readonly workerUrl: string;

  fields: TFields;

  readonly in: {
    add: (parent: DbRowRef<TAllowedParentCollections>) => Promise<void>;
    remove: (parent: DbRowRef<TAllowedParentCollections>) => Promise<void>;
    list: () => Promise<Array<DbRowRef<TAllowedParentCollections>>>;
  };

  readonly members: {
    add: (username: string, options: { role: MemberRole }) => Promise<void>;
    remove: (username: string) => Promise<void>;
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
    this.workerUrl = row.workerUrl;
    this.fields = fields;

    this.in = {
      add: async (parent: DbRowRef<TAllowedParentCollections>) => {
        await this.backend.addParent(this.toRef(), parent);
      },
      remove: async (parent: DbRowRef<TAllowedParentCollections>) => {
        await this.backend.removeParent(this.toRef(), parent);
      },
      list: async () => this.backend.listParents<TAllowedParentCollections>(this.toRef()),
    };

    this.members = {
      add: async (username: string, options: { role: MemberRole }) => {
        await this.backend.addMember(this.toRef(), username, options.role);
      },
      remove: async (username: string) => {
        await this.backend.removeMember(this.toRef(), username);
      },
      list: async () => this.backend.listDirectMembers(this.toRef()),
      effective: async () => this.backend.listEffectiveMembers(this.toRef()),
      listAll: async () => this.backend.listMembers(this.toRef()),
    };
  }

  connectCrdt(callbacks: CrdtConnectCallbacks): CrdtConnection {
    return this.backend.connectCrdt(this.toRef(), callbacks);
  }

  async refresh(): Promise<this> {
    this.fields = await this.backend.refreshFields(this.toRef()) as TFields;
    return this;
  }

  toRef(): DbRowRef<TCollection> {
    return {
      id: this.id,
      collection: this.collection,
      owner: this.owner,
      workerUrl: this.workerUrl,
    };
  }
}
