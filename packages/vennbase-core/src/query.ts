import { createAdaptivePoller } from "./polling.js";
import { OptimisticStore } from "./optimistic-store.js";
import { RowHandle } from "./row-handle.js";
import { normalizeParentRefs, normalizeRowRef, sameRowRef } from "./row-reference.js";
import type {
  CollectionName,
  DbIndexKeyProjection,
  DbQueryOptions,
  DbQueryRows,
  DbQuerySelect,
  InferDbQuerySelect,
  DbQueryWatchCallbacks,
  DbQueryWatchHandle,
  DbSchema,
  RowRef,
} from "./schema.js";
import { getCollectionIndexKeyFieldNames, getCollectionSpec, pickIndexKeyFieldValues } from "./schema.js";
import { stableJsonStringify } from "./stable-json.js";
import type { Transport } from "./transport.js";
import { encodeFieldValue } from "./key-encoding.js";
import type { JsonValue } from "./types.js";

interface DbQueryBaseRow {
  rowId: string;
  collection: string;
  fields: Record<string, JsonValue>;
}

interface DbFullQueryRow extends DbQueryBaseRow {
  owner?: string;
  baseUrl: string;
}

interface DbIndexKeyQueryRow {
  rowId: string;
  collection: string;
  fields: Record<string, JsonValue>;
}

interface DbFullQueryResponse {
  rows: DbFullQueryRow[];
}

interface DbIndexKeyQueryResponse {
  rows: DbIndexKeyQueryRow[];
}

function matchesWhere(
  fields: Record<string, JsonValue>,
  where: Record<string, JsonValue> | undefined,
): boolean {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([field, value]) => encodeFieldValue(fields[field] ?? null) === encodeFieldValue(value));
}

function compareFieldValue(left: JsonValue | undefined, right: JsonValue | undefined): number {
  if (left === right) {
    return 0;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }

  if (typeof left === "object" || typeof right === "object") {
    return stableJsonStringify(left).localeCompare(stableJsonStringify(right));
  }

  return String(left ?? "").localeCompare(String(right ?? ""));
}

function compareQueriedRows(
  left: DbFullQueryRow,
  right: DbFullQueryRow,
  orderBy: string | undefined,
  order: "asc" | "desc",
): number {
  if (orderBy) {
    const comparison = compareFieldValue(left.fields[orderBy], right.fields[orderBy]);
    if (comparison !== 0) {
      return order === "desc" ? -comparison : comparison;
    }
  }

  const baseUrlComparison = left.baseUrl.localeCompare(right.baseUrl);
  if (baseUrlComparison !== 0) {
    return order === "desc" ? -baseUrlComparison : baseUrlComparison;
  }

  const rowIdComparison = left.rowId.localeCompare(right.rowId);
  return order === "desc" ? -rowIdComparison : rowIdComparison;
}

function compareIndexKeyRows(
  left: DbIndexKeyQueryRow,
  right: DbIndexKeyQueryRow,
  orderBy: string | undefined,
  order: "asc" | "desc",
): number {
  if (orderBy) {
    const comparison = compareFieldValue(left.fields[orderBy], right.fields[orderBy]);
    if (comparison !== 0) {
      return order === "desc" ? -comparison : comparison;
    }
  }

  const rowIdComparison = left.rowId.localeCompare(right.rowId);
  return order === "desc" ? -rowIdComparison : rowIdComparison;
}

function snapshotRows(rows: Array<{
  id: string;
  collection: string;
  fields?: unknown;
  kind?: "index-key-projection";
  owner?: string;
  ref?: RowRef;
}>): string {
  const snapshot = rows.map((row) => ({
    id: row.id,
    collection: row.collection,
    ...(row.kind ? { kind: row.kind } : {}),
    owner: row.owner,
    ...("ref" in row && row.ref ? { ref: row.ref } : {}),
    ...("fields" in row ? { fields: row.fields } : {}),
  }));
  return stableJsonStringify(snapshot);
}

function validateIndexedQuery(
  indexKeyFields: string[],
  where: Record<string, JsonValue> | undefined,
  orderBy: string | undefined,
): void {
  for (const fieldName of Object.keys(where ?? {})) {
    if (!indexKeyFields.includes(fieldName)) {
      throw new Error(`where.${fieldName} must be an index-key field`);
    }
  }

  if (orderBy && !indexKeyFields.includes(orderBy)) {
    throw new Error("orderBy must be an index-key field");
  }
}

interface QueryRowLoader<Schema extends DbSchema> {
  getRow<TCollection extends CollectionName<Schema>>(
    row: RowRef<TCollection>,
  ): Promise<RowHandle<Schema, TCollection>>;
  peekRow?<TCollection extends CollectionName<Schema>>(
    row: RowRef<TCollection>,
  ): RowHandle<Schema, TCollection> | null;
}

export class Query<Schema extends DbSchema> {
  constructor(
    private readonly transport: Transport,
    private readonly rowLoader: QueryRowLoader<Schema>,
    private readonly optimisticStore: OptimisticStore,
    private readonly schema: Schema,
    private readonly resolveOptions?: <
      TCollection extends CollectionName<Schema>,
      TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
    >(
      collection: TCollection,
      options: TOptions,
    ) => Promise<TOptions>,
    private readonly resolveOptionsSync?: <
      TCollection extends CollectionName<Schema>,
      TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
    >(
      collection: TCollection,
      options: TOptions,
    ) => TOptions,
  ) {}

  async query<
    TCollection extends CollectionName<Schema>,
    TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
  >(
    collection: TCollection,
    options: TOptions,
  ): Promise<DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>> {
    return this.runQuery(collection, options);
  }

  peekQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection, "full">,
  ): Array<RowHandle<Schema, TCollection>> {
    const collectionSpec = getCollectionSpec(this.schema, collection);
    const resolvedOptions = this.resolveOptionsSync
      ? this.resolveOptionsSync(collection, options)
      : options;
    const parentRefs = normalizeParentRefs(resolvedOptions.in);
    if (parentRefs.length === 0) {
      throw new Error(
        (collectionSpec.in ?? []).length === 0
          ? `Collection ${String(collection)} cannot be queried because queries always require in and this collection has no parent scope.`
          : `Collection ${String(collection)} query requires in.`,
      );
    }

    const indexKeyFields = getCollectionIndexKeyFieldNames(collectionSpec);
    const orderBy = resolvedOptions.orderBy;
    validateIndexedQuery(
      indexKeyFields,
      resolvedOptions.where as Record<string, JsonValue> | undefined,
      orderBy,
    );

    return this.peekFullQuery(collection, parentRefs, {
      orderBy,
      order: resolvedOptions.order ?? "asc",
      limit: Math.max(1, Math.min(200, resolvedOptions.limit ?? 50)),
      where: resolvedOptions.where as Record<string, JsonValue> | undefined,
    });
  }

  private async runQuery<
    TCollection extends CollectionName<Schema>,
    TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
  >(
    collection: TCollection,
    options: TOptions,
  ): Promise<DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>> {
    const collectionSpec = getCollectionSpec(this.schema, collection);
    const resolvedOptions = this.resolveOptions
      ? await this.resolveOptions(collection, options)
      : options;
    const parentRefs = normalizeParentRefs(resolvedOptions.in);
    if (parentRefs.length === 0) {
      throw new Error(
        (collectionSpec.in ?? []).length === 0
          ? `Collection ${String(collection)} cannot be queried because queries always require in and this collection has no parent scope.`
          : `Collection ${String(collection)} query requires in.`,
      );
    }

    const indexKeyFields = getCollectionIndexKeyFieldNames(collectionSpec);
    const orderBy = resolvedOptions.orderBy;
    const limit = Math.max(1, Math.min(200, resolvedOptions.limit ?? 50));
    const select = resolvedOptions.select ?? "full";

    validateIndexedQuery(
      indexKeyFields,
      resolvedOptions.where as Record<string, JsonValue> | undefined,
      orderBy,
    );

    if (select === "indexKeys") {
      return await this.runIndexKeyQuery(collection, parentRefs, {
        orderBy,
        order: resolvedOptions.order ?? "asc",
        limit,
        where: resolvedOptions.where as Record<string, JsonValue> | undefined,
      }) as DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>;
    }

    return await this.runFullQuery(collection, parentRefs, {
      orderBy,
      order: resolvedOptions.order ?? "asc",
      limit,
      where: resolvedOptions.where as Record<string, JsonValue> | undefined,
    }) as DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>;
  }

  private async runFullQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    parentRefs: RowRef[],
    options: {
      orderBy: string | undefined;
      order: "asc" | "desc";
      limit: number;
      where: Record<string, JsonValue> | undefined;
    },
  ): Promise<Array<RowHandle<Schema, TCollection>>> {
    const parentResults = await Promise.all(
      parentRefs.map(async (parent) => {
        if (this.optimisticStore.hasPendingCreate(parent)) {
          return [];
        }

        const response = await this.transport.row(parent).request<DbFullQueryResponse>("db/query", {
          collection,
          select: "full",
          orderBy: options.orderBy,
          order: options.order,
          limit: options.limit,
          where: options.where,
        });

        return response.rows.filter((row) => {
          return !this.optimisticStore.shouldExcludeFromParent({
            id: row.rowId,
            collection,
            baseUrl: row.baseUrl,
          }, parent);
        }).map((row) => {
          this.optimisticStore.recordParent({
            id: row.rowId,
            collection,
            baseUrl: row.baseUrl,
          }, parent);
          return row;
        });
      }),
    );

    const deduped = new Map<string, DbFullQueryRow>();
    for (const result of parentResults) {
      for (const row of result) {
        const key = `${row.baseUrl}:${row.rowId}`;
        if (!deduped.has(key)) {
          deduped.set(key, row);
        }
      }
    }

    const optimisticRows = this.optimisticStore.getOptimisticQueryRows(collection, parentRefs)
      .map((record) => ({
        rowId: record.row.id,
        owner: record.owner,
        baseUrl: record.row.baseUrl,
        collection,
        fields: this.optimisticStore.getLogicalFields(record.row) ?? {},
      }))
      .filter((row) => matchesWhere(row.fields, options.where));

    for (const row of optimisticRows) {
      const key = `${row.baseUrl}:${row.rowId}`;
      if (!deduped.has(key)) {
        deduped.set(key, row);
      }
    }

    const mergedRows = Array.from(deduped.values()).filter((row) => {
      const localFields = this.optimisticStore.getLogicalFields({
        id: row.rowId,
        baseUrl: row.baseUrl,
      });
      const hasLocalMaterialization = this.optimisticStore.hasPendingCreate({
        id: row.rowId,
        baseUrl: row.baseUrl,
      }) || this.optimisticStore.getOwner({
        id: row.rowId,
        baseUrl: row.baseUrl,
      }) !== null;
      return matchesWhere(hasLocalMaterialization ? (localFields ?? row.fields) : row.fields, options.where);
    });

    if (options.orderBy) {
      mergedRows.sort((left, right) => compareQueriedRows(
        left,
        right,
        options.orderBy,
        options.order,
      ));
    }

    const limitedRows = mergedRows.slice(0, options.limit);

    const hydrated = await Promise.all(
      limitedRows.map(async (row) => {
        const rowRef: RowRef<TCollection> = normalizeRowRef({
          id: row.rowId,
          collection,
          baseUrl: row.baseUrl,
        });

        return this.rowLoader.getRow(rowRef);
      }),
    );

    return hydrated;
  }

  private peekFullQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    parentRefs: RowRef[],
    options: {
      orderBy: string | undefined;
      order: "asc" | "desc";
      limit: number;
      where: Record<string, JsonValue> | undefined;
    },
  ): Array<RowHandle<Schema, TCollection>> {
    if (!this.rowLoader.peekRow) {
      return [];
    }

    const deduped = new Map<string, DbFullQueryRow>();
    for (const record of this.optimisticStore.getOptimisticQueryRows(collection, parentRefs)) {
      const fields = this.optimisticStore.getLogicalFields(record.row);
      const owner = this.optimisticStore.getOwner(record.row);
      if (!fields || !owner) {
        continue;
      }

      if (!matchesWhere(fields, options.where)) {
        continue;
      }

      deduped.set(`${record.row.baseUrl}:${record.row.id}`, {
        rowId: record.row.id,
        owner,
        baseUrl: record.row.baseUrl,
        collection,
        fields,
      });
    }

    const rows = Array.from(deduped.values());
    if (options.orderBy) {
      rows.sort((left, right) => compareQueriedRows(
        left,
        right,
        options.orderBy,
        options.order,
      ));
    }

    return rows
      .slice(0, options.limit)
      .map((row) => this.rowLoader.peekRow?.(normalizeRowRef({
        id: row.rowId,
        collection,
        baseUrl: row.baseUrl,
      })))
      .filter((row): row is RowHandle<Schema, TCollection> => row !== null);
  }

  private async runIndexKeyQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    parentRefs: RowRef[],
    options: {
      orderBy: string | undefined;
      order: "asc" | "desc";
      limit: number;
      where: Record<string, JsonValue> | undefined;
    },
  ): Promise<Array<DbIndexKeyProjection<Schema, TCollection>>> {
    const collectionSpec = getCollectionSpec(this.schema, collection);
    const parentResults = await Promise.all(
      parentRefs.map(async (parent) => {
        if (this.optimisticStore.hasPendingCreate(parent)) {
          return [];
        }

        const response = await this.transport.row(parent).request<DbIndexKeyQueryResponse>("db/query", {
          collection,
          select: "indexKeys",
          orderBy: options.orderBy,
          order: options.order,
          limit: options.limit,
          where: options.where,
        });

        return response.rows.filter((row) => {
          const optimisticRow = this.optimisticStore.findIndexKeyQueryRow(collection, row.rowId);
          return !(optimisticRow?.pendingParentRemoves.some((candidate) => sameRowRef(candidate, parent)) ?? false);
        });
      }),
    );

    const deduped = new Map<string, DbIndexKeyQueryRow>();
    for (const result of parentResults) {
      for (const row of result) {
        if (!deduped.has(row.rowId)) {
          deduped.set(row.rowId, row);
        }
      }
    }

    const optimisticRows = this.optimisticStore.getOptimisticQueryRows(collection, parentRefs)
      .map((record) => ({
        rowId: record.row.id,
        collection,
        fields: pickIndexKeyFieldValues(collectionSpec, this.optimisticStore.getLogicalFields(record.row) ?? {}),
      }))
      .filter((row) => matchesWhere(row.fields, options.where));

    for (const row of optimisticRows) {
      if (!deduped.has(row.rowId)) {
        deduped.set(row.rowId, row);
      }
    }

    const mergedRows = Array.from(deduped.values()).map((row) => {
      const optimisticRow = this.optimisticStore.findIndexKeyQueryRow(collection, row.rowId);
      const localFields = optimisticRow ? this.optimisticStore.getLogicalFields(optimisticRow.row) : null;
      return {
        ...row,
        fields: pickIndexKeyFieldValues(collectionSpec, localFields ?? row.fields),
      };
    }).filter((row) => matchesWhere(row.fields, options.where));

    if (options.orderBy) {
      mergedRows.sort((left, right) => compareIndexKeyRows(
        left,
        right,
        options.orderBy,
        options.order,
      ));
    }

    return mergedRows.slice(0, options.limit).map((row) => ({
      kind: "index-key-projection",
      id: row.rowId,
      collection,
      fields: pickIndexKeyFieldValues(collectionSpec, row.fields),
    })) as Array<DbIndexKeyProjection<Schema, TCollection>>;
  }

  watchQuery<
    TCollection extends CollectionName<Schema>,
    TOptions extends DbQueryOptions<Schema, TCollection, DbQuerySelect> = DbQueryOptions<Schema, TCollection, "full">,
  >(
    collection: TCollection,
    options: TOptions,
    callbacks: DbQueryWatchCallbacks<DbQueryRows<Schema, TCollection, InferDbQuerySelect<TOptions>>[number]>,
  ): DbQueryWatchHandle {
    let lastSnapshot: string | null = null;

    const poller = createAdaptivePoller({
      run: async ({ markActivity }) => {
        const result = await this.query(collection, options);
        const nextSnapshot = snapshotRows(result as unknown as Array<{
          id: string;
          collection: string;
          fields?: unknown;
          kind?: "index-key-projection";
          owner?: string;
          ref?: RowRef;
        }>);

        if (lastSnapshot === nextSnapshot) {
          return;
        }

        lastSnapshot = nextSnapshot;
        callbacks.onChange(result);
        markActivity();
      },
      onError: (error) => {
        callbacks.onError?.(error);
      },
    });

    return {
      disconnect() {
        poller.disconnect();
      },
      refresh() {
        return poller.refresh();
      },
    };
  }
}
