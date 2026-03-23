import type { Transport } from "./transport";
import type { DbMemberInfo, DbSchema, MemberRole, RowRef } from "./schema";

interface ListMembersResponse {
  members: Array<{ username: string; role: MemberRole }>;
}

interface EffectiveMembersResponse {
  members: DbMemberInfo[];
}

export class Members<Schema extends DbSchema> {
  constructor(private readonly transport: Transport) {}

  async addRemote(row: RowRef, username: string, role: MemberRole): Promise<void> {
    await this.transport.row(row).request("members/add", {
      username,
      role,
    });
  }

  async removeRemote(row: RowRef, username: string): Promise<void> {
    await this.transport.row(row).request("members/remove", {
      username,
    });
  }

  async listDirect(row: RowRef): Promise<Array<{ username: string; role: MemberRole }>> {
    const payload = await this.transport.row(row).request<ListMembersResponse>("members/direct", {});
    return payload.members;
  }

  async listEffective(row: RowRef): Promise<Array<DbMemberInfo<Schema>>> {
    const payload = await this.transport.row(row).request<EffectiveMembersResponse>("members/effective", {});
    return payload.members as Array<DbMemberInfo<Schema>>;
  }
}
