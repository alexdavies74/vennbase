import { createAdaptivePoller } from "./polling";
import { OptimisticStore } from "./optimistic-store";
import { RowHandle } from "./row-handle";
import { normalizeParentRefs, normalizeRowRef } from "./row-reference";
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
import { getCollectionSpec, pickKeyFieldValues } from "./schema";
import { stableJsonStringify } from "./stable-json";
import type { Transport } from "./transport";
import { encodeFieldValue } from "./key-encoding";
import type { JsonValue } from "./types";

interface DbQueryRow {
  rowId: string;
  owner?: string;
  baseUrl: string;
  collection: string;
  fields: Record<string, JsonValue>;
}

interface DbQueryResponse {
  rows: DbQueryRow[];
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
  left: DbQueryRow,
  right: DbQueryRow,
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

function snapshotRows(rows: Array<{
  id: string;
  collection: string;
  ref: RowRef;
  fields: unknown;
  owner?: string;
}>): string {
  const snapshot = rows.map((row) => ({
    id: row.id,
    collection: row.collection,
    owner: row.owner,
    ref: row.ref,
    fields: row.fields,
  }));
  return stableJsonStringify(snapshot);
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
    const orderBy = resolvedOptions.orderBy;
    const limit = Math.max(1, Math.min(200, resolvedOptions.limit ?? 50));
    const select = resolvedOptions.select ?? "full";

    const parentResults = await Promise.all(
      parentRefs.map(async (parent) => {
        if (this.optimisticStore.hasPendingCreate(parent)) {
          return [];
        }

        const response = await this.transport.row(parent).request<DbQueryResponse>("db/query", {
          collection,
          select,
          orderBy,
          order: resolvedOptions.order ?? "asc",
          limit,
          where: resolvedOptions.where,
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

    const deduped = new Map<string, DbQueryRow>();
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
        fields: select === "keys"
          ? pickKeyFieldValues(collectionSpec, this.optimisticStore.getLogicalFields(record.row) ?? {})
          : (this.optimisticStore.getLogicalFields(record.row) ?? {}),
      }))
      .filter((row) => matchesWhere(row.fields, resolvedOptions.where as Record<string, JsonValue> | undefined));

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
      const effectiveFields = select === "keys"
        ? pickKeyFieldValues(collectionSpec, localFields ?? row.fields)
        : (localFields ?? row.fields);
      return matchesWhere(effectiveFields, resolvedOptions.where as Record<string, JsonValue> | undefined);
    });

    if (orderBy) {
      mergedRows.sort((left, right) => compareQueriedRows(
        left,
        right,
        orderBy,
        resolvedOptions.order ?? "asc",
      ));
    }

    const limitedRows = mergedRows.slice(0, limit);
    if (select === "keys") {
      return limitedRows.map((row) => ({
        id: row.rowId,
        ref: normalizeRowRef({
          id: row.rowId,
          collection,
          baseUrl: row.baseUrl,
        }),
        collection,
        fields: pickKeyFieldValues(collectionSpec, row.fields),
      })) as Array<DbQueryProjectedRow<Schema, TCollection>>;
    }

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
          ref: RowRef;
          fields: unknown;
          owner?: string;
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
