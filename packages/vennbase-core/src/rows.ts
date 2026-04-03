import { RowHandle } from "./row-handle.js";
import { createMutationReceipt, type MutationReceipt } from "./mutation-receipt.js";
import { OptimisticStore } from "./optimistic-store.js";
import type { RowRuntime } from "./row-runtime.js";
import type { WriteSettler } from "./write-settler.js";
import type {
  CollectionName,
  DbCreateOptions,
  DbRowFields,
  DbSchema,
  InsertFields,
  RowRef,
  RowInput,
  RowFields,
} from "./schema.js";
import { applyDefaults, assertCreateParents, assertValidFieldValues, getCollectionSpec, pickIndexKeyFieldValues } from "./schema.js";
import type { Transport } from "./transport.js";
import { normalizeParentRefs, normalizeRowRef, rowRefKey } from "./row-reference.js";
import type { JsonValue } from "./types.js";

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
    ) => RowHandle<Schema, TCollection>,
    private readonly addParentRemote: (child: RowInput, parent: RowInput) => Promise<void>,
    private readonly notifyLocalMutation: () => void,
  ) {}

  create<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    fields: InsertFields<Schema, TCollection>,
    options?: DbCreateOptions<Schema, TCollection>,
  ): MutationReceipt<RowHandle<Schema, TCollection>> {
    const collectionSpec = getCollectionSpec(this.schema, collection);
    const parentRefs = normalizeParentRefs(options?.in);
    assertCreateParents(collection, collectionSpec, parentRefs);
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

    return receipt;
  }

  update<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: RowInput<TCollection>,
    fields: Partial<RowFields<Schema, TCollection>>,
  ): MutationReceipt<RowHandle<Schema, TCollection>> {
    const rowRef = normalizeRowRef(row);
    const collectionSpec = getCollectionSpec(this.schema, collection);
    assertValidFieldValues(collection, collectionSpec, fields as Record<string, unknown>);
    const previousFields = this.optimisticStore.getLogicalFields(rowRef);
    const owner = this.optimisticStore.getOwner(rowRef);
    if (!previousFields) {
      throw new Error(`Cannot update ${collection} row ${rowRef.id} before it has been loaded locally.`);
    }
    if (!owner) {
      throw new Error(`Cannot update ${collection} row ${rowRef.id} before its owner has been loaded locally.`);
    }

    const nextFields = this.optimisticStore.applyOverlay(rowRef, collection, fields as Record<string, JsonValue>);
    const handle = this.createRowHandle(collection, rowRef, owner, nextFields as RowFields<Schema, TCollection>);
    const receipt = createMutationReceipt(handle);
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

    return receipt;
  }

  async getRow<TCollection extends CollectionName<Schema>>(
    row: RowInput<TCollection>,
  ): Promise<RowHandle<Schema, TCollection>> {
    const rowRef = normalizeRowRef(row);
    const fields = await this.refreshFields(rowRef);
    let owner = this.optimisticStore.getOwner(rowRef);
    if (!owner) {
      const snapshot = await this.rowRuntime.getRow(rowRef);
      owner = snapshot.owner;
      this.optimisticStore.recordParents(rowRef, snapshot.parentRefs);
    }
    this.optimisticStore.upsertBaseRow(rowRef, owner, rowRef.collection, fields);
    return this.createRowHandle(rowRef.collection as TCollection, rowRef, owner, fields as RowFields<Schema, TCollection>);
  }

  async refreshFields(row: RowInput): Promise<Record<string, JsonValue>> {
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
    row: RowInput,
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

  getCurrentParents(row: RowInput, serverParents: RowRef[] = []): RowRef[] {
    return this.optimisticStore.getCurrentParents(normalizeRowRef(row), serverParents);
  }

  private async syncParentIndexes(row: RowInput, fields: Record<string, JsonValue>): Promise<void> {
    const rowRef = normalizeRowRef(row);
    const snapshot = await this.rowRuntime.getRow(rowRef);
    const collectionSpec = getCollectionSpec(this.schema, rowRef.collection);
    const indexKeyFields = pickIndexKeyFieldValues(collectionSpec, fields);
    this.optimisticStore.recordParents(rowRef, snapshot.parentRefs);
    await Promise.all(
      snapshot.parentRefs.map((parentRef) =>
        this.transport.row(parentRef).request("parents/update-index", {
          childRef: rowRef,
          childOwner: snapshot.owner,
          collection: rowRef.collection,
          fields: indexKeyFields,
        }),
      ),
    );
  }
}
