import { RowHandle } from "./row-handle";
import { createMutationReceipt } from "./mutation-receipt";
import { OptimisticStore } from "./optimistic-store";
import type { RowRuntime } from "./row-runtime";
import type { WriteSettler } from "./write-settler";
import type {
  AllowedParentCollections,
  CollectionName,
  DbPutOptions,
  DbRowFields,
  DbSchema,
  InsertFields,
  RowRef,
  RowFields,
} from "./schema";
import { applyDefaults, assertPutParents, assertValidFieldValues, getCollectionSpec } from "./schema";
import type { Transport } from "./transport";
import { normalizeParentRefs, normalizeRowRef, rowRefKey } from "./row-reference";
import type { JsonValue } from "./types";

interface GetFieldsResponse {
  fields: Record<string, JsonValue>;
  collection: string | null;
}

export class Rows<Schema extends DbSchema> {
  constructor(
    private readonly transport: Transport,
    private readonly rowRuntime: RowRuntime,
    private readonly schema: Schema,
    private readonly optimisticStore: OptimisticStore,
    private readonly writeSettler: WriteSettler,
    private readonly createRowHandle: <
      TCollection extends CollectionName<Schema>,
    >(
      collection: TCollection,
      row: RowRef<TCollection>,
      owner: string,
      fields: RowFields<Schema, TCollection>,
    ) => RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>,
    private readonly addParentRemote: (child: RowRef, parent: RowRef) => Promise<void>,
    private readonly notifyLocalMutation: () => void,
  ) {}

  put<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    options?: DbPutOptions<Schema, TCollection>,
  ): RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema> {
    const collectionSpec = getCollectionSpec(this.schema, collection);
    const parentRefs = normalizeParentRefs(options?.in);
    assertPutParents(collection, collectionSpec, parentRefs);
    assertValidFieldValues(collection, collectionSpec, fields as Record<string, unknown>);

    const plan = this.rowRuntime.planRow(options?.name ?? `${collection}-${crypto.randomUUID().slice(0, 8)}`);
    const rowRef: RowRef<TCollection> = normalizeRowRef({
      id: plan.row.id,
      collection,
      baseUrl: plan.row.baseUrl,
    });

    const payload = applyDefaults(
      collectionSpec,
      fields as InsertFields<Schema, TCollection> & DbRowFields,
    ) as Record<string, JsonValue>;

    const handle = this.createRowHandle(
      collection,
      rowRef,
      plan.row.owner,
      payload as RowFields<Schema, TCollection>,
    );
    const receipt = createMutationReceipt(handle);

    this.optimisticStore.beginCreate({
      row: rowRef,
      owner: plan.row.owner,
      collection,
      fields: payload,
      parents: parentRefs,
      receipt,
    });
    handle.attachSettlement(receipt);
    this.notifyLocalMutation();

    const dependencies = parentRefs
      .map((parent) => this.optimisticStore.getPendingCreateDependency(parent))
      .filter((dependency): dependency is Promise<unknown> => dependency !== null);

    this.writeSettler.schedule(
      `row:${rowRefKey(rowRef)}`,
      async () => {
        try {
          await this.rowRuntime.commitPlannedRow(plan);
          await this.transport.row(rowRef).request("fields/set", {
            fields: payload,
            collection,
          });

          for (const parent of parentRefs) {
            await this.addParentRemote(rowRef, parent);
          }

          this.optimisticStore.confirmCreate(rowRef);
          receipt.resolve(handle);
        } catch (error) {
          this.optimisticStore.rollbackCreate(rowRef);
          receipt.reject(error);
          this.notifyLocalMutation();
          throw error;
        }

        this.notifyLocalMutation();
        return handle;
      },
      dependencies,
    ).catch(() => undefined);

    return handle;
  }

  update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: RowRef<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema> {
    const rowRef = normalizeRowRef({
      id: row.id,
      collection,
      baseUrl: row.baseUrl,
    });
    const collectionSpec = getCollectionSpec(this.schema, collection);
    assertValidFieldValues(collection, collectionSpec, fields as Record<string, unknown>);
    const previousFields = this.optimisticStore.getLogicalFields(rowRef);
    const owner = this.optimisticStore.getOwner(rowRef);
    if (!previousFields) {
      throw new Error(`Cannot update ${collection} row ${row.id} before it has been loaded locally.`);
    }
    if (!owner) {
      throw new Error(`Cannot update ${collection} row ${row.id} before its owner has been loaded locally.`);
    }

    const nextFields = this.optimisticStore.applyOverlay(rowRef, collection, fields as Record<string, JsonValue>);
    const handle = this.createRowHandle(collection, rowRef, owner, nextFields as RowFields<Schema, TCollection>);
    const receipt = createMutationReceipt(handle);
    handle.attachSettlement(receipt);
    this.notifyLocalMutation();

    const dependencies = [
      this.optimisticStore.getPendingCreateDependency(rowRef),
    ].filter((dependency): dependency is Promise<unknown> => dependency !== null);

    this.writeSettler.schedule(
      `row:${rowRefKey(rowRef)}`,
      async () => {
        try {
          const response = await this.transport.row(rowRef).request<GetFieldsResponse>("fields/set", {
            fields,
            merge: true,
            collection,
          });
          this.optimisticStore.upsertBaseRow(rowRef, owner, collection, response.fields);
          this.optimisticStore.commitOverlay(rowRef);
          await this.syncParentIndexes(rowRef, response.fields);
          receipt.resolve(handle);
        } catch (error) {
          this.optimisticStore.rollbackOverlay(rowRef, previousFields);
          receipt.reject(error);
          this.notifyLocalMutation();
          throw error;
        }

        this.notifyLocalMutation();
        return handle;
      },
      dependencies,
    ).catch(() => undefined);

    return handle;
  }

  async getRow<TCollection extends CollectionName<Schema>>(
    row: RowRef<TCollection>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    const rowRef = normalizeRowRef(row);
    const fields = await this.refreshFields(rowRef);
    const owner = this.optimisticStore.getOwner(rowRef) ?? (await this.rowRuntime.getRow(rowRef)).owner;
    this.optimisticStore.upsertBaseRow(rowRef, owner, row.collection, fields);
    return this.createRowHandle(row.collection, rowRef, owner, fields as RowFields<Schema, TCollection>);
  }

  async refreshFields(row: RowRef): Promise<Record<string, JsonValue>> {
    const rowRef = normalizeRowRef(row);
    const localFields = this.optimisticStore.getLogicalFields(rowRef);
    const localCollection = this.optimisticStore.getCollection(rowRef);
    const localRecord = this.optimisticStore.getRowByRef(rowRef);
    if (localFields && localRecord?.pendingCreate) {
      return localFields;
    }

    const response = await this.transport.row(rowRef).request<GetFieldsResponse>("fields/get", {});
    if (localCollection) {
      this.optimisticStore.upsertBaseRow(
        {
          ...rowRef,
          collection: localCollection,
        },
        localRecord?.owner ?? "",
        localCollection,
        response.fields,
      );
    }
    return {
      ...response.fields,
      ...(this.optimisticStore.getLogicalFields(rowRef) ?? {}),
    };
  }

  async fetchWithCollection(
    row: RowRef,
  ): Promise<{ fields: Record<string, JsonValue>; collection: string | null }> {
    const rowRef = normalizeRowRef(row);
    const localRecord = this.optimisticStore.getRowByRef(rowRef);
    if (localRecord?.pendingCreate) {
      return {
        fields: this.optimisticStore.getLogicalFields(localRecord.row) ?? {},
        collection: localRecord.collection,
      };
    }

    const response = await this.transport.row(rowRef).request<GetFieldsResponse>("fields/get", {});
    const collection = response.collection ?? localRecord?.collection ?? null;
    if (collection) {
      this.optimisticStore.upsertBaseRow(
        {
          ...rowRef,
          collection,
        },
        localRecord?.owner ?? "",
        collection,
        response.fields,
      );
    }
    return {
      fields: this.optimisticStore.getLogicalFields(rowRef) ?? response.fields,
      collection: response.collection,
    };
  }

  getCurrentParents(row: RowRef, serverParents: RowRef[] = []): RowRef[] {
    return this.optimisticStore.getCurrentParents(row, serverParents);
  }

  private async syncParentIndexes(row: RowRef, fields: Record<string, JsonValue>): Promise<void> {
    const snapshot = await this.rowRuntime.getRow(row);
    this.optimisticStore.recordParents(row, snapshot.parentRefs);
    await Promise.all(
      snapshot.parentRefs.map((parentRef) =>
        this.transport.row(parentRef).request("parents/update-index", {
          childRef: row,
          childOwner: snapshot.owner,
          collection: row.collection,
          fields,
        }),
      ),
    );
  }
}
