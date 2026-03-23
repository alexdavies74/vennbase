import type { RowRuntime } from "./row-runtime";
import type { Transport } from "./transport";
import type { DbSchema, RowRef } from "./schema";
import { assertParentAllowed } from "./schema";
import { normalizeRowRef } from "./row-reference";
import type { JsonValue } from "./types";

export class Parents {
  constructor(
    private readonly transport: Transport,
    private readonly rowRuntime: RowRuntime,
    private readonly schema: DbSchema,
    private readonly refreshFields: (row: RowRef) => Promise<Record<string, JsonValue>>,
  ) {}

  async addRemote(child: RowRef, parent: RowRef): Promise<void> {
    const childRef = normalizeRowRef(child);
    const parentRef = normalizeRowRef(parent);
    assertParentAllowed(this.schema, childRef.collection, parentRef.collection);

    const childSnapshot = await this.rowRuntime.getRow(childRef);
    const childFields = await this.refreshFields(childRef);
    const childSpec = this.schema[childRef.collection];

    await this.transport.row(parentRef).request("parents/register-child", {
      childRef,
      childOwner: childSnapshot.owner,
      collection: childRef.collection,
      fields: childFields,
      schema: {
        indexes: childSpec?.indexes,
      },
    });

    await this.transport.row(childRef).request("parents/link-parent", {
      parentRef,
    });
  }

  async removeRemote(child: RowRef, parent: RowRef): Promise<void> {
    const childRef = normalizeRowRef(child);
    const parentRef = normalizeRowRef(parent);
    const childSnapshot = await this.rowRuntime.getRow(childRef);

    await this.transport.row(parentRef).request("parents/unregister-child", {
      childRef,
      childOwner: childSnapshot.owner,
      collection: childRef.collection,
    });

    await this.transport.row(childRef).request("parents/unlink-parent", {
      parentRef,
    });
  }

  async list<TParentCollection extends string>(child: RowRef): Promise<Array<RowRef<TParentCollection>>> {
    const childRef = normalizeRowRef(child);
    const row = await this.rowRuntime.getRow(childRef);
    return row.parentRefs as Array<RowRef<TParentCollection>>;
  }
}
