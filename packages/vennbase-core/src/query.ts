import { createAdaptivePoller } from "./polling";
import { OptimisticStore } from "./optimistic-store";
import { RowHandle } from "./row-handle";
import { normalizeParentRefs, normalizeRowRef, sameRowRef } from "./row-reference";
import type {
  CollectionName,
  DbFullQueryOptions,
  DbKeyQueryOptions,
  DbQueryOptions,
  DbQueryProjectedRow,
  DbQueryWatchCallbacks,
  DbQueryWatchHandle,
  DbSchema,
  RowRef,
} from "./schema";
import { getCollectionKeyFieldNames, getCollectionSpec, pickKeyFieldValues } from "./schema";
import { stableJsonStringify } from "./stable-json";
import type { Transport } from "./transport";
import { encodeFieldValue } from "./key-encoding";
import type { JsonValue } from "./types";

interface DbQueryBaseRow {
  rowId: string;
  collection: string;
  fields: Record<string, JsonValue>;
}

interface DbFullQueryRow extends DbQueryBaseRow {
  owner?: string;
  baseUrl: string;
}

interface DbKeyQueryRow extends DbQueryBaseRow {}

interface DbFullQueryResponse {
  rows: DbFullQueryRow[];
}

interface DbKeyQueryResponse {
  rows: DbKeyQueryRow[];
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

function compareProjectedRows(
  left: DbKeyQueryRow,
  right: DbKeyQueryRow,
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
  fields: unknown;
  owner?: string;
  ref?: RowRef;
}>): string {
  const snapshot = rows.map((row) => ({
    id: row.id,
    collection: row.collection,
    owner: row.owner,
    ...("ref" in row && row.ref ? { ref: row.ref } : {}),
    fields: row.fields,
  }));
  return stableJsonStringify(snapshot);
}

function validateIndexedQuery(
  keyFields: string[],
  where: Record<string, JsonValue> | undefined,
  orderBy: string | undefined,
): void {
  for (const fieldName of Object.keys(where ?? {})) {
    if (!keyFields.includes(fieldName)) {
      throw new Error(`where.${fieldName} must be a key field`);
    }
  }

  if (orderBy && !keyFields.includes(orderBy)) {
    throw new Error("orderBy must be a key field");
  }
}

interface QueryRowLoader<Schema extends DbSchema> {
  getRow<TCollection extends CollectionName<Schema>>(
    row: RowRef<TCollection>,
  ): Promise<RowHandle<Schema, TCollection>>;
}

export class Query<Schema extends DbSchema> {
  constructor(
    private readonly transport: Transport,
    private readonly rowLoader: QueryRowLoader<Schema>,
    private readonly optimisticStore: OptimisticStore,
    private readonly schema: Schema,
    private readonly resolveOptions?: <TCollection extends CollectionName<Schema>>(
      collection: TCollection,
      options: DbQueryOptions<Schema, TCollection>,
    ) => Promise<DbQueryOptions<Schema, TCollection>>,
  ) {}

  async query<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbKeyQueryOptions<Schema, TCollection>,
  ): Promise<Array<DbQueryProjectedRow<Schema, TCollection>>>;
  async query<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbFullQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<Schema, TCollection>>>;
  async query<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<Schema, TCollection>> | Array<DbQueryProjectedRow<Schema, TCollection>>>;
  async query<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<Schema, TCollection>> | Array<DbQueryProjectedRow<Schema, TCollection>>> {
    return this.runQuery(collection, options);
  }

  private async runQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<Schema, TCollection>> | Array<DbQueryProjectedRow<Schema, TCollection>>> {
    const resolvedOptions = this.resolveOptions
      ? await this.resolveOptions(collection, options)
      : options;
    const parentRefs = normalizeParentRefs(resolvedOptions.in);
    if (parentRefs.length === 0) {
      throw new Error("query requires at least one parent in scope");
    }

    const collectionSpec = getCollectionSpec(this.schema, collection);
    const keyFields = getCollectionKeyFieldNames(collectionSpec);
    const orderBy = resolvedOptions.orderBy;
    const limit = Math.max(1, Math.min(200, resolvedOptions.limit ?? 50));
    const select = resolvedOptions.select ?? "full";

    validateIndexedQuery(
      keyFields,
      resolvedOptions.where as Record<string, JsonValue> | undefined,
      orderBy,
    );

    if (select === "keys") {
      return this.runKeyQuery(collection, parentRefs, {
        orderBy,
        order: resolvedOptions.order ?? "asc",
        limit,
        where: resolvedOptions.where as Record<string, JsonValue> | undefined,
      });
    }

    return this.runFullQuery(collection, parentRefs, {
      orderBy,
      order: resolvedOptions.order ?? "asc",
      limit,
      where: resolvedOptions.where as Record<string, JsonValue> | undefined,
    });
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
      return matchesWhere(localFields ?? row.fields, options.where);
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

  private async runKeyQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    parentRefs: RowRef[],
    options: {
      orderBy: string | undefined;
      order: "asc" | "desc";
      limit: number;
      where: Record<string, JsonValue> | undefined;
    },
  ): Promise<Array<DbQueryProjectedRow<Schema, TCollection>>> {
    const collectionSpec = getCollectionSpec(this.schema, collection);
    const parentResults = await Promise.all(
      parentRefs.map(async (parent) => {
        if (this.optimisticStore.hasPendingCreate(parent)) {
          return [];
        }

        const response = await this.transport.row(parent).request<DbKeyQueryResponse>("db/query", {
          collection,
          select: "keys",
          orderBy: options.orderBy,
          order: options.order,
          limit: options.limit,
          where: options.where,
        });

        return response.rows.filter((row) => {
          const optimisticRow = this.optimisticStore.findAnonymousQueryRow(collection, row.rowId);
          return !(optimisticRow?.pendingParentRemoves.some((candidate) => sameRowRef(candidate, parent)) ?? false);
        });
      }),
    );

    const deduped = new Map<string, DbKeyQueryRow>();
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
        fields: pickKeyFieldValues(collectionSpec, this.optimisticStore.getLogicalFields(record.row) ?? {}),
      }))
      .filter((row) => matchesWhere(row.fields, options.where));

    for (const row of optimisticRows) {
      if (!deduped.has(row.rowId)) {
        deduped.set(row.rowId, row);
      }
    }

    const mergedRows = Array.from(deduped.values()).map((row) => {
      const optimisticRow = this.optimisticStore.findAnonymousQueryRow(collection, row.rowId);
      const localFields = optimisticRow ? this.optimisticStore.getLogicalFields(optimisticRow.row) : null;
      return {
        ...row,
        fields: pickKeyFieldValues(collectionSpec, localFields ?? row.fields),
      };
    }).filter((row) => matchesWhere(row.fields, options.where));

    if (options.orderBy) {
      mergedRows.sort((left, right) => compareProjectedRows(
        left,
        right,
        options.orderBy,
        options.order,
      ));
    }

    return mergedRows.slice(0, options.limit).map((row) => ({
      id: row.rowId,
      collection,
      fields: pickKeyFieldValues(collectionSpec, row.fields),
    })) as Array<DbQueryProjectedRow<Schema, TCollection>>;
  }

  watchQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbKeyQueryOptions<Schema, TCollection>,
    callbacks: DbQueryWatchCallbacks<DbQueryProjectedRow<Schema, TCollection>>,
  ): DbQueryWatchHandle;
  watchQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbFullQueryOptions<Schema, TCollection>,
    callbacks: DbQueryWatchCallbacks<RowHandle<Schema, TCollection>>,
  ): DbQueryWatchHandle;
  watchQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
    callbacks: DbQueryWatchCallbacks<RowHandle<Schema, TCollection> | DbQueryProjectedRow<Schema, TCollection>>,
  ): DbQueryWatchHandle;
  watchQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
    callbacks: DbQueryWatchCallbacks<RowHandle<Schema, TCollection> | DbQueryProjectedRow<Schema, TCollection>>,
  ): DbQueryWatchHandle {
    let lastSnapshot: string | null = null;

    const poller = createAdaptivePoller({
      run: async ({ markActivity }) => {
        const result = await this.query(collection, options);
        const nextSnapshot = snapshotRows(result as unknown as Array<{
          id: string;
          collection: string;
          fields: unknown;
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
