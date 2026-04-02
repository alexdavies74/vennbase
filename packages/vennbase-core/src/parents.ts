import type { RowRuntime } from "./row-runtime.js";
import type { Transport } from "./transport.js";
import type { DbSchema, RowInput, RowRef } from "./schema.js";
import { assertParentAllowed, getCollectionKeyFieldNames, pickKeyFieldValues } from "./schema.js";
import { normalizeRowRef } from "./row-reference.js";
import type { JsonValue } from "./types.js";

export class Parents {
  constructor(
    private readonly transport: Transport,
    private readonly rowRuntime: RowRuntime,
    private readonly schema: DbSchema,
    private readonly refreshFields: (row: RowInput) => Promise<Record<string, JsonValue>>,
  ) {}

  async addRemote(child: RowInput, parent: RowInput): Promise<void> {
    const childRef = normalizeRowRef(child);
    const parentRef = normalizeRowRef(parent);
    assertParentAllowed(this.schema, childRef.collection, parentRef.collection);

    const childSnapshot = await this.rowRuntime.getRow(childRef);
    const childFields = await this.refreshFields(childRef);
    const childSpec = this.schema[childRef.collection];
    const keyFields = childSpec ? getCollectionKeyFieldNames(childSpec) : [];
    const keyFieldValues = childSpec ? pickKeyFieldValues(childSpec, childFields) : {};

    await this.transport.row(parentRef).request("parents/register-child", {
      childRef,
      childOwner: childSnapshot.owner,
      collection: childRef.collection,
      fields: keyFieldValues,
      schema: {
        keyFields,
      },
    });

    await this.transport.row(childRef).request("parents/link-parent", {
      parentRef,
    });
  }

  async removeRemote(child: RowInput, parent: RowInput): Promise<void> {
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

  async list<TParentCollection extends string>(child: RowInput): Promise<Array<RowRef<TParentCollection>>> {
    const childRef = normalizeRowRef(child);
    const row = await this.rowRuntime.getRow(childRef);
    return row.parentRefs as Array<RowRef<TParentCollection>>;
  }
}
