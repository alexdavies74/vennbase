import { createAdaptivePoller } from "./polling";
import { OptimisticStore } from "./optimistic-store";
import { RowHandle } from "./row-handle";
import { normalizeParentRefs } from "./row-reference";
import type {
  AllowedParentCollections,
  CollectionName,
  DbQueryOptions,
  DbQueryWatchCallbacks,
  DbQueryWatchHandle,
  DbRowFields,
  DbRowRef,
  DbSchema,
  RowFields,
} from "./schema";
import { getCollectionSpec, pickIndex } from "./schema";
import { stableJsonStringify } from "./stable-json";
import type { Transport } from "./transport";
import { normalizeTarget } from "./transport";
import type { JsonValue } from "./types";

interface DbQueryRow {
  rowId: string;
  owner: string;
  target: string;
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

  return Object.entries(where).every(([field, value]) => fields[field] === value);
}

function matchesIndexValue(
  row: DbQueryRow,
  indexFields: readonly string[],
  value: JsonValue | readonly JsonValue[] | undefined,
): boolean {
  if (value === undefined) {
    return true;
  }

  const decoded = Array.isArray(value) ? value : [value];
  return indexFields.every((field, index) => row.fields[field] === decoded[index]);
}

function resolveSelectedIndexValue(
  indexFields: readonly string[],
  options: { value?: JsonValue | readonly JsonValue[]; where?: Record<string, JsonValue> },
): JsonValue | readonly JsonValue[] | undefined {
  if (options.value !== undefined) {
    return options.value;
  }

  if (indexFields.length === 1 && options.where && indexFields[0] in options.where) {
    return options.where[indexFields[0]];
  }

  return undefined;
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

  return String(left ?? "").localeCompare(String(right ?? ""));
}

function compareIndexedRows(
  left: DbQueryRow,
  right: DbQueryRow,
  indexFields: readonly string[],
  order: "asc" | "desc",
): number {
  for (const fieldName of indexFields) {
    const comparison = compareFieldValue(left.fields[fieldName], right.fields[fieldName]);
    if (comparison !== 0) {
      return order === "desc" ? -comparison : comparison;
    }
  }

  const ownerComparison = left.owner.localeCompare(right.owner);
  if (ownerComparison !== 0) {
    return order === "desc" ? -ownerComparison : ownerComparison;
  }

  const rowIdComparison = left.rowId.localeCompare(right.rowId);
  return order === "desc" ? -rowIdComparison : rowIdComparison;
}

function snapshotRows(rows: Array<RowHandle<string, DbRowFields>>): string {
  const snapshot = rows.map((row) => ({
    id: row.id,
    collection: row.collection,
    owner: row.owner,
    target: row.target,
    fields: row.fields,
  }));
  return stableJsonStringify(snapshot);
}

interface QueryRowLoader<Schema extends DbSchema> {
  getRow<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    row: DbRowRef<TCollection>,
  ): Promise<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>>;
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
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>>> {
    const resolvedOptions = this.resolveOptions
      ? await this.resolveOptions(collection, options)
      : options;
    const parentRefs = normalizeParentRefs(resolvedOptions.in);
    if (parentRefs.length === 0) {
      throw new Error("query requires at least one parent in scope");
    }

    const collectionSpec = getCollectionSpec(this.schema, collection);
    const selectedIndex = pickIndex(collectionSpec, resolvedOptions);
    const limit = Math.max(1, Math.min(200, resolvedOptions.limit ?? 50));

    const parentResults = await Promise.all(
      parentRefs.map(async (parent) => {
        if (this.optimisticStore.hasPendingCreate(parent)) {
          return [];
        }

        let indexName: string | undefined;
        let value: string | null | undefined;
        if (selectedIndex) {
          indexName = selectedIndex.name;
          value = selectedIndex.encodedValue;
        }

        const response = await this.transport.row(parent).request<DbQueryResponse>("db/query", {
          collection,
          order: resolvedOptions.order ?? "asc",
          limit,
          index: indexName,
          value,
          where: selectedIndex ? undefined : resolvedOptions.where,
        });

        return response.rows.filter((row) => {
          return !this.optimisticStore.shouldExcludeFromParent({
            id: row.rowId,
            owner: row.owner,
            target: normalizeTarget(row.target),
            collection,
          }, parent);
        });
      }),
    );

    const deduped = new Map<string, DbQueryRow>();
    for (const result of parentResults) {
      for (const row of result) {
        const key = `${row.owner}:${row.rowId}`;
        if (!deduped.has(key)) {
          deduped.set(key, row);
        }
      }
    }

    const optimisticRows = this.optimisticStore.getOptimisticQueryRows(collection, parentRefs)
      .map((record) => ({
        rowId: record.row.id,
        owner: record.row.owner,
        target: record.row.target,
        collection,
        fields: this.optimisticStore.getLogicalFields(record.row) ?? {},
      }))
      .filter((row) => {
        if (selectedIndex) {
          const indexFields = collectionSpec.indexes?.[selectedIndex.name]?.fields ?? [];
          return matchesIndexValue(row, indexFields, resolveSelectedIndexValue(
            indexFields,
            {
              value: resolvedOptions.value as JsonValue | readonly JsonValue[] | undefined,
              where: resolvedOptions.where as Record<string, JsonValue> | undefined,
            },
          ));
        }
        return matchesWhere(row.fields, resolvedOptions.where as Record<string, JsonValue> | undefined);
      });

    for (const row of optimisticRows) {
      const key = `${row.owner}:${row.rowId}`;
      if (!deduped.has(key)) {
        deduped.set(key, row);
      }
    }

    const mergedRows = Array.from(deduped.values()).filter((row) => {
      const localFields = this.optimisticStore.getLogicalFields({
        id: row.rowId,
        owner: row.owner,
        target: normalizeTarget(row.target),
      }) ?? row.fields;

      if (selectedIndex) {
        const indexFields = collectionSpec.indexes?.[selectedIndex.name]?.fields ?? [];
        return matchesIndexValue({
          ...row,
          fields: localFields,
        }, indexFields, resolveSelectedIndexValue(
          indexFields,
          {
            value: resolvedOptions.value as JsonValue | readonly JsonValue[] | undefined,
            where: resolvedOptions.where as Record<string, JsonValue> | undefined,
          },
        ));
      }

      return matchesWhere(localFields, resolvedOptions.where as Record<string, JsonValue> | undefined);
    });
    if (selectedIndex) {
      const indexFields = collectionSpec.indexes?.[selectedIndex.name]?.fields ?? [];
      mergedRows.sort((left, right) => compareIndexedRows(
        left,
        right,
        indexFields,
        resolvedOptions.order ?? "asc",
      ));
    }

    const limitedRows = mergedRows.slice(0, limit);
    const hydrated = await Promise.all(
      limitedRows.map(async (row) => {
        const rowRef: DbRowRef<TCollection> = {
          id: row.rowId,
          collection,
          owner: row.owner,
          target: normalizeTarget(row.target),
        };

        return this.rowLoader.getRow(collection, rowRef);
      }),
    );

    return hydrated;
  }

  watchQuery<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
    callbacks: DbQueryWatchCallbacks<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>>,
  ): DbQueryWatchHandle {
    let lastSnapshot: string | null = null;

    const poller = createAdaptivePoller({
      run: async ({ markActivity }) => {
        const result = await this.query(collection, options);
        const nextSnapshot = snapshotRows(result as unknown as Array<RowHandle<string, DbRowFields>>);

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
