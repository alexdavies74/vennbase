import type { Transport } from "./transport.js";
import type { DbMemberInfo, DbSchema, MemberRole, RowInput } from "./schema.js";
import { normalizeRowRef } from "./row-reference.js";

interface ListMembersResponse {
  members: Array<{ username: string; role: MemberRole }>;
}

interface EffectiveMembersResponse {
  members: DbMemberInfo[];
}

export class Members<Schema extends DbSchema> {
  constructor(private readonly transport: Transport) {}

  async addRemote(row: RowInput, username: string, role: MemberRole): Promise<void> {
    await this.transport.row(normalizeRowRef(row)).request("members/add", {
      username,
      role,
    });
  }

  async removeRemote(row: RowInput, username: string): Promise<void> {
    await this.transport.row(normalizeRowRef(row)).request("members/remove", {
      username,
    });
  }

  async listDirect(row: RowInput): Promise<Array<{ username: string; role: MemberRole }>> {
    const payload = await this.transport.row(normalizeRowRef(row)).request<ListMembersResponse>("members/direct", {});
    return payload.members;
  }

  async listEffective(row: RowInput): Promise<Array<DbMemberInfo<Schema>>> {
    const payload = await this.transport.row(normalizeRowRef(row)).request<EffectiveMembersResponse>("members/effective", {});
    return payload.members as Array<DbMemberInfo<Schema>>;
  }
}
