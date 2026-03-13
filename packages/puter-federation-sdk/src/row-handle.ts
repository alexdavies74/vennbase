import type { CrdtConnectCallbacks, CrdtConnection, JsonValue } from "./types";
import type { DbMemberInfo, DbRowFields, DbRowRef, MemberRole } from "./schema";

export interface RowHandleBackend {
  addParent(child: DbRowRef, parent: DbRowRef): Promise<void>;
  removeParent(child: DbRowRef, parent: DbRowRef): Promise<void>;
  listParents(child: DbRowRef): Promise<DbRowRef[]>;
  addMember(row: DbRowRef, username: string, role: MemberRole): Promise<void>;
  removeMember(row: DbRowRef, username: string): Promise<void>;
  listDirectMembers(row: DbRowRef): Promise<Array<{ username: string; role: MemberRole }>>;
  listEffectiveMembers(row: DbRowRef): Promise<DbMemberInfo[]>;
  refreshFields(row: DbRowRef): Promise<Record<string, JsonValue>>;
  connectCrdt(row: DbRowRef, callbacks: CrdtConnectCallbacks): CrdtConnection;
  listMembers(row: DbRowRef): Promise<string[]>;
}

export class RowHandle<
  TCollection extends string = string,
  TFields extends DbRowFields = DbRowFields,
  TAllowedParentCollections extends string = string,
> {
  readonly id: string;

  readonly collection: TCollection;

  readonly owner: string;

  readonly workerUrl: string;

  fields: TFields;

  readonly in: {
    add: (parent: DbRowRef<TAllowedParentCollections>) => Promise<void>;
    remove: (parent: DbRowRef<TAllowedParentCollections>) => Promise<void>;
    list: () => Promise<DbRowRef[]>;
  };

  readonly members: {
    add: (username: string, options: { role: MemberRole }) => Promise<void>;
    remove: (username: string) => Promise<void>;
    list: () => Promise<Array<{ username: string; role: MemberRole }>>;
    effective: () => Promise<DbMemberInfo[]>;
    listAll: () => Promise<string[]>;
  };

  constructor(
    private readonly backend: RowHandleBackend,
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
      list: async () => this.backend.listParents(this.toRef()),
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
