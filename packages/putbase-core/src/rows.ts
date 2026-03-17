import { RowHandle, type RowHandleBackend } from "./row-handle";
import type { Rooms } from "./rooms";
import type {
  AllowedParentCollections,
  CollectionName,
  DbPutOptions,
  DbRowFields,
  DbRowLocator,
  DbRowRef,
  DbSchema,
  InsertFields,
  RowFields,
} from "./schema";
import { applyDefaults, assertPutParents, getCollectionSpec } from "./schema";
import type { Transport } from "./transport";
import { roomEndpointUrl, stripTrailingSlash } from "./transport";
import type { JsonValue } from "./types";

interface GetFieldsResponse {
  fields: Record<string, JsonValue>;
  collection: string | null;
}

export class Rows<Schema extends DbSchema> {
  constructor(
    private readonly transport: Transport,
    private readonly rooms: Rooms,
    private readonly schema: Schema,
    private readonly backend: RowHandleBackend<Schema>,
    private readonly addParent: (child: DbRowRef, parent: DbRowRef) => Promise<void>,
  ) {}

  async put<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    options: DbPutOptions<Schema, TCollection> = {},
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    const collectionSpec = getCollectionSpec(this.schema, collection);
    const parentRefs = normalizeParents(options.in);
    assertPutParents(collection, collectionSpec, parentRefs);

    const room = await this.rooms.createRoom(
      options.name ?? `${collection}-${crypto.randomUUID().slice(0, 8)}`,
    );
    const rowRef: DbRowRef<TCollection> = {
      id: room.id,
      collection,
      owner: room.owner,
      workerUrl: stripTrailingSlash(room.workerUrl),
    };

    const payload = applyDefaults(
      collectionSpec,
      fields as InsertFields<Schema, TCollection> & DbRowFields,
    ) as Record<string, JsonValue>;

    await this.transport.request({
      url: roomEndpointUrl(rowRef, "fields/set"),
      action: "fields.set",
      roomId: rowRef.id,
      payload: {
        fields: payload,
        collection,
      },
    });

    for (const parent of parentRefs) {
      await this.addParent(rowRef, parent);
    }

    return new RowHandle<
      TCollection,
      RowFields<Schema, TCollection>,
      AllowedParentCollections<Schema, TCollection>,
      Schema
    >(
      this.backend,
      rowRef,
      payload as RowFields<Schema, TCollection>,
    );
  }

  async update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    const rowRef: DbRowRef<TCollection> = { ...row, collection };
    const response = await this.transport.request<GetFieldsResponse>({
      url: roomEndpointUrl(rowRef, "fields/set"),
      action: "fields.set",
      roomId: rowRef.id,
      payload: {
        fields,
        merge: true,
        collection,
      },
    });
    await this.syncParentIndexes(rowRef, response.fields);

    return this.getRow(collection, rowRef);
  }

  async getRow<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    const rowRef: DbRowRef<TCollection> = { ...row, collection };
    const fields = await this.refreshFields(rowRef);
    return new RowHandle<
      TCollection,
      RowFields<Schema, TCollection>,
      AllowedParentCollections<Schema, TCollection>,
      Schema
    >(this.backend, rowRef, fields as RowFields<Schema, TCollection>);
  }

  async refreshFields(row: DbRowLocator): Promise<Record<string, JsonValue>> {
    const response = await this.transport.request<GetFieldsResponse>({
      url: roomEndpointUrl(row, "fields/get"),
      action: "fields.get",
      roomId: row.id,
      payload: {},
    });
    return response.fields;
  }

  async fetchWithCollection(
    row: DbRowLocator,
  ): Promise<{ fields: Record<string, JsonValue>; collection: string | null }> {
    const response = await this.transport.request<GetFieldsResponse>({
      url: roomEndpointUrl(row, "fields/get"),
      action: "fields.get",
      roomId: row.id,
      payload: {},
    });
    return { fields: response.fields, collection: response.collection };
  }

  private async syncParentIndexes(row: DbRowRef, fields: Record<string, JsonValue>): Promise<void> {
    const room = await this.rooms.getRoom(row.workerUrl);
    const childSpec = this.schema[row.collection];
    await Promise.all(
      room.parentRefs.map((parentRef) =>
        this.transport.request({
          url: roomEndpointUrl(parentRef, "register-child"),
          action: "parents.register-child",
          roomId: parentRef.id,
          payload: {
            childRowId: row.id,
            childOwner: row.owner,
            childWorkerUrl: row.workerUrl,
            collection: row.collection,
            fields,
            schema: {
              indexes: childSpec?.indexes,
            },
          },
        }),
      ),
    );
  }
}

function normalizeParents(input: DbRowRef | DbRowRef[] | undefined): DbRowRef[] {
  if (!input) return [];
  return Array.isArray(input) ? input : [input];
}
