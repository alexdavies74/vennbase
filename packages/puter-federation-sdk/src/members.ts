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
    await this.transport.request(roomEndpointUrl(row, "members-add"), "POST", {
      username,
      role,
    });
  }

  async remove(row: DbRowLocator, username: string): Promise<void> {
    await this.transport.request(roomEndpointUrl(row, "members-remove"), "POST", {
      username,
    });
  }

  async listDirect(row: DbRowLocator): Promise<Array<{ username: string; role: MemberRole }>> {
    const payload = await this.transport.request<ListMembersResponse>(
      roomEndpointUrl(row, "members-direct"),
      "GET",
    );
    return payload.members;
  }

  async listEffective(row: DbRowLocator): Promise<Array<DbMemberInfo<Schema>>> {
    const payload = await this.transport.request<EffectiveMembersResponse>(
      roomEndpointUrl(row, "members-effective"),
      "GET",
    );
    return payload.members as Array<DbMemberInfo<Schema>>;
  }
}
