import type { Transport } from "./transport";
import { roomEndpointUrl } from "./transport";
import type { DbMemberInfo, DbRowLocator, DbSchema, MemberRole } from "./schema";

interface ListMembersResponse {
  members: Array<{ username: string; role: MemberRole }>;
}

interface EffectiveMembersResponse {
  members: DbMemberInfo[];
}

export class Members<Schema extends DbSchema> {
  constructor(private readonly transport: Transport) {}

  async add(row: DbRowLocator, username: string, role: MemberRole): Promise<void> {
    await this.transport.request({
      url: roomEndpointUrl(row, "members-add"),
      action: "members.add",
      roomId: row.id,
      payload: {
        username,
        role,
      },
    });
  }

  async remove(row: DbRowLocator, username: string): Promise<void> {
    await this.transport.request({
      url: roomEndpointUrl(row, "members-remove"),
      action: "members.remove",
      roomId: row.id,
      payload: {
        username,
      },
    });
  }

  async listDirect(row: DbRowLocator): Promise<Array<{ username: string; role: MemberRole }>> {
    const payload = await this.transport.request<ListMembersResponse>({
      url: roomEndpointUrl(row, "members-direct"),
      action: "members.direct",
      roomId: row.id,
      payload: {},
    });
    return payload.members;
  }

  async listEffective(row: DbRowLocator): Promise<Array<DbMemberInfo<Schema>>> {
    const payload = await this.transport.request<EffectiveMembersResponse>({
      url: roomEndpointUrl(row, "members-effective"),
      action: "members.effective",
      roomId: row.id,
      payload: {},
    });
    return payload.members as Array<DbMemberInfo<Schema>>;
  }
}
