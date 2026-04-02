import type { MemberRole, RowRef } from "./schema.js";
import { normalizeBaseUrl } from "./transport.js";
import type { ShareToken, VennbaseUser, Row } from "./types.js";
import type { Transport } from "./transport.js";

export interface PlannedRow {
  readonly row: Row;
  readonly ref: RowRef;
}

export class WritePlanner {
  constructor(private readonly transport: Transport) {}

  planRow(args: {
    collection: string;
    federationWorkerUrl: string;
    name: string;
    user: VennbaseUser;
  }): PlannedRow {
    const id = this.transport.createId("row");
    const baseUrl = normalizeBaseUrl(args.federationWorkerUrl);

    return {
      row: {
        id,
        name: args.name,
        owner: args.user.username,
        baseUrl,
        createdAt: Date.now(),
      },
      ref: {
        id,
        collection: args.collection,
        baseUrl,
      },
    };
  }

  planShareToken(args: { rowId: string; invitedBy: string; role: MemberRole }): ShareToken {
    return {
      token: this.transport.createId("invite"),
      rowId: args.rowId,
      invitedBy: args.invitedBy,
      createdAt: Date.now(),
      role: args.role,
    };
  }
}
