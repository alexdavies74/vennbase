import type { Rooms } from "./rooms";
import type { Transport } from "./transport";
import { roomEndpointUrl, stripTrailingSlash } from "./transport";
import type { DbSchema, DbRowRef } from "./schema";
import { assertParentAllowed } from "./schema";
import type { JsonValue } from "./types";

export class Parents {
  constructor(
    private readonly transport: Transport,
    private readonly rooms: Rooms,
    private readonly schema: DbSchema,
    private readonly refreshFields: (row: DbRowRef) => Promise<Record<string, JsonValue>>,
  ) {}

  async add(child: DbRowRef, parent: DbRowRef): Promise<void> {
    assertParentAllowed(this.schema, child.collection, parent.collection);

    const childFields = await this.refreshFields(child);
    const childSpec = this.schema[child.collection];

    await this.transport.request(roomEndpointUrl(parent, "register-child"), "POST", {
      childRowId: child.id,
      childOwner: child.owner,
      childWorkerUrl: child.workerUrl,
      collection: child.collection,
      fields: childFields,
      schema: {
        indexes: childSpec?.indexes,
      },
    });

    await this.transport.request(roomEndpointUrl(child, "link-parent"), "POST", {
      parentRef: parent,
    });
  }

  async remove(child: DbRowRef, parent: DbRowRef): Promise<void> {
    await this.transport.request(roomEndpointUrl(parent, "unregister-child"), "POST", {
      childRowId: child.id,
      childOwner: child.owner,
      collection: child.collection,
    });

    await this.transport.request(roomEndpointUrl(child, "unlink-parent"), "POST", {
      parentRef: parent,
    });
  }

  async list<TParentCollection extends string>(child: DbRowRef): Promise<Array<DbRowRef<TParentCollection>>> {
    const room = await this.rooms.getRoom(child.workerUrl);
    return room.parentRefs.map((parentRef) => ({
      ...parentRef,
      workerUrl: stripTrailingSlash(parentRef.workerUrl),
    })) as Array<DbRowRef<TParentCollection>>;
  }
}
