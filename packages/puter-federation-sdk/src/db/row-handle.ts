import type { JsonValue } from "../types";
import type { DbMemberInfo, DbRowRef, MemberRole } from "./types";

export interface RowHandleBackend {
  addParent(child: DbRowRef, parent: DbRowRef): Promise<void>;
  removeParent(child: DbRowRef, parent: DbRowRef): Promise<void>;
  listParents(child: DbRowRef): Promise<DbRowRef[]>;
  addMember(row: DbRowRef, username: string, role: MemberRole): Promise<void>;
  removeMember(row: DbRowRef, username: string): Promise<void>;
  listDirectMembers(row: DbRowRef): Promise<Array<{ username: string; role: MemberRole }>>;
  listEffectiveMembers(row: DbRowRef): Promise<DbMemberInfo[]>;
  refreshFields(row: DbRowRef): Promise<Record<string, JsonValue>>;
}

export class RowHandle {
  readonly id: string;

  readonly collection: string;

  readonly owner: string;

  readonly workerUrl: string;

  fields: Record<string, JsonValue>;

  readonly in: {
    add: (parent: DbRowRef) => Promise<void>;
    remove: (parent: DbRowRef) => Promise<void>;
    list: () => Promise<DbRowRef[]>;
  };

  readonly members: {
    add: (username: string, options: { role: MemberRole }) => Promise<void>;
    remove: (username: string) => Promise<void>;
    list: () => Promise<Array<{ username: string; role: MemberRole }>>;
    effective: () => Promise<DbMemberInfo[]>;
  };

  constructor(
    private readonly backend: RowHandleBackend,
    row: DbRowRef,
    fields: Record<string, JsonValue>,
  ) {
    this.id = row.id;
    this.collection = row.collection;
    this.owner = row.owner;
    this.workerUrl = row.workerUrl;
    this.fields = fields;

    this.in = {
      add: async (parent: DbRowRef) => {
        await this.backend.addParent(this.toRef(), parent);
      },
      remove: async (parent: DbRowRef) => {
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
    };
  }

  async refresh(): Promise<this> {
    this.fields = await this.backend.refreshFields(this.toRef());
    return this;
  }

  toRef(): DbRowRef {
    return {
      id: this.id,
      collection: this.collection,
      owner: this.owner,
      workerUrl: this.workerUrl,
    };
  }
}
