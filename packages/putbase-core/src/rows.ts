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
  DbRowLocator,
  DbRowRef,
  DbSchema,
  InsertFields,
  RowFields,
} from "./schema";
import { applyDefaults, assertPutParents, assertValidFieldValues, getCollectionSpec } from "./schema";
import type { Transport } from "./transport";
import { normalizeTarget } from "./transport";
import { normalizeParentRefs, toRowLocator, toRowRef } from "./row-reference";
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
      row: DbRowRef<TCollection>,
      fields: RowFields<Schema, TCollection>,
    ) => RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>,
    private readonly addParentRemote: (child: DbRowRef, parent: DbRowRef) => Promise<void>,
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
    const rowRef: DbRowRef<TCollection> = toRowRef({
      id: plan.row.id,
      collection,
      owner: plan.row.owner,
      target: normalizeTarget(plan.row.target),
    });

    const payload = applyDefaults(
      collectionSpec,
      fields as InsertFields<Schema, TCollection> & DbRowFields,
    ) as Record<string, JsonValue>;

    const handle = this.createRowHandle(
      collection,
      rowRef,
      payload as RowFields<Schema, TCollection>,
    );
    const receipt = createMutationReceipt(handle);

    this.optimisticStore.beginCreate({
      row: rowRef,
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
      `row:${rowRef.owner}:${rowRef.id}`,
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
    row: DbRowRef<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema> {
    const rowRef: DbRowRef<TCollection> = toRowRef({
      id: row.id,
      collection,
      owner: row.owner,
      target: row.target,
    });
    const collectionSpec = getCollectionSpec(this.schema, collection);
    assertValidFieldValues(collection, collectionSpec, fields as Record<string, unknown>);
    const previousFields = this.optimisticStore.getLogicalFields(rowRef);
    if (!previousFields) {
      throw new Error(`Cannot update ${collection} row ${row.id} before it has been loaded locally.`);
    }

    const nextFields = this.optimisticStore.applyOverlay(rowRef, collection, fields as Record<string, JsonValue>);
    const handle = this.createRowHandle(collection, rowRef, nextFields as RowFields<Schema, TCollection>);
    const receipt = createMutationReceipt(handle);
    handle.attachSettlement(receipt);
    this.notifyLocalMutation();

    const dependencies = [
      this.optimisticStore.getPendingCreateDependency(rowRef),
    ].filter((dependency): dependency is Promise<unknown> => dependency !== null);

    this.writeSettler.schedule(
      `row:${rowRef.owner}:${rowRef.id}`,
      async () => {
        try {
          const response = await this.transport.row(rowRef).request<GetFieldsResponse>("fields/set", {
            fields,
            merge: true,
            collection,
          });
          this.optimisticStore.upsertBaseRow(rowRef, collection, response.fields);
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
    collection: TCollection,
    row: DbRowRef<TCollection>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>> {
    const rowRef: DbRowRef<TCollection> = toRowRef({
      id: row.id,
      collection,
      owner: row.owner,
      target: row.target,
    });
    const fields = await this.refreshFields(rowRef);
    this.optimisticStore.upsertBaseRow(rowRef, collection, fields);
    return this.createRowHandle(collection, rowRef, fields as RowFields<Schema, TCollection>);
  }

  async refreshFields(row: DbRowLocator): Promise<Record<string, JsonValue>> {
    const localFields = this.optimisticStore.getLogicalFields(toRowLocator(row));
    const localCollection = this.optimisticStore.getCollection(toRowLocator(row));
    const localRecord = this.optimisticStore.getRowByTarget(row.target);
    if (localFields && localRecord?.pendingCreate) {
      return localFields;
    }

    const response = await this.transport.row(toRowLocator(row)).request<GetFieldsResponse>("fields/get", {});
    if (localCollection) {
      this.optimisticStore.upsertBaseRow(
        {
          ...toRowLocator(row),
          collection: localCollection,
        },
        localCollection,
        response.fields,
      );
    }
    return {
      ...response.fields,
      ...(this.optimisticStore.getLogicalFields(toRowLocator(row)) ?? {}),
    };
  }

  async fetchWithCollection(
    row: DbRowLocator,
  ): Promise<{ fields: Record<string, JsonValue>; collection: string | null }> {
    const localRecord = this.optimisticStore.getRowByTarget(normalizeTarget(row.target));
    if (localRecord?.pendingCreate) {
      return {
        fields: this.optimisticStore.getLogicalFields(localRecord.row) ?? {},
        collection: localRecord.collection,
      };
    }

    const response = await this.transport.row(toRowLocator(row)).request<GetFieldsResponse>("fields/get", {});
    const collection = response.collection ?? localRecord?.collection ?? null;
    if (collection) {
      this.optimisticStore.upsertBaseRow(
        {
          ...toRowLocator(row),
          collection,
        },
        collection,
        response.fields,
      );
    }
    return {
      fields: this.optimisticStore.getLogicalFields(toRowLocator(row)) ?? response.fields,
      collection: response.collection,
    };
  }

  getCurrentParents(row: DbRowRef, serverParents: DbRowRef[] = []): DbRowRef[] {
    return this.optimisticStore.getCurrentParents(row, serverParents);
  }

  private async syncParentIndexes(row: DbRowRef, fields: Record<string, JsonValue>): Promise<void> {
    const snapshot = await this.rowRuntime.getRow(row.target);
    this.optimisticStore.recordParents(row, snapshot.parentRefs);
    await Promise.all(
      snapshot.parentRefs.map((parentRef) =>
        this.transport.row(parentRef).request("parents/update-index", {
          childRowId: row.id,
          childOwner: row.owner,
          childTarget: row.target,
          collection: row.collection,
          fields,
        }),
      ),
    );
  }
}
