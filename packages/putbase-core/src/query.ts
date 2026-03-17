import { createAdaptivePoller } from "./polling";
import { RowHandle } from "./row-handle";
import type { Rows } from "./rows";
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
import type { Transport } from "./transport";
import { roomEndpointUrl, stripTrailingSlash } from "./transport";
import type { JsonValue } from "./types";

interface DbQueryRow {
  rowId: string;
  owner: string;
  workerUrl: string;
  collection: string;
  fields: Record<string, JsonValue>;
}

interface DbQueryResponse {
  rows: DbQueryRow[];
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function snapshotRows(rows: Array<RowHandle<string, DbRowFields>>): string {
  const snapshot = rows.map((row) => ({
    id: row.id,
    collection: row.collection,
    owner: row.owner,
    workerUrl: row.workerUrl,
    fields: row.fields,
  }));
  return stableJsonStringify(snapshot);
}

function normalizeParents(input: DbRowRef | DbRowRef[]): DbRowRef[] {
  return Array.isArray(input) ? input : [input];
}

export class Query<Schema extends DbSchema> {
  constructor(
    private readonly transport: Transport,
    private readonly rows: Rows<Schema>,
    private readonly schema: Schema,
  ) {}

  async query<TCollection extends CollectionName<Schema>>(
    collection: TCollection,
    options: DbQueryOptions<Schema, TCollection>,
  ): Promise<Array<RowHandle<TCollection, RowFields<Schema, TCollection>, AllowedParentCollections<Schema, TCollection>, Schema>>> {
    const parentRefs = normalizeParents(options.in);
    if (parentRefs.length === 0) {
      throw new Error("query requires at least one parent in scope");
    }

    const collectionSpec = getCollectionSpec(this.schema, collection);
    const selectedIndex = pickIndex(collectionSpec, options);
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));

    const parentResults = await Promise.all(
      parentRefs.map(async (parent) => {
        let indexName: string | undefined;
        let value: string | null | undefined;
        if (selectedIndex) {
          indexName = selectedIndex.name;
          value = selectedIndex.encodedValue;
        }

        return this.transport.request<DbQueryResponse>({
          url: roomEndpointUrl(parent, "db-query"),
          action: "db.query",
          roomId: parent.id,
          payload: {
            collection,
            order: options.order ?? "asc",
            limit,
            index: indexName,
            value,
            where: selectedIndex ? undefined : options.where,
          },
        });
      }),
    );

    const deduped = new Map<string, DbQueryRow>();
    for (const result of parentResults) {
      for (const row of result.rows) {
        const key = `${row.owner}:${row.rowId}`;
        if (!deduped.has(key)) {
          deduped.set(key, row);
        }
      }
    }

    const queryRows = Array.from(deduped.values()).slice(0, limit);
    const hydrated = await Promise.all(
      queryRows.map(async (row) => {
        const rowRef: DbRowRef<TCollection> = {
          id: row.rowId,
          collection,
          owner: row.owner,
          workerUrl: stripTrailingSlash(row.workerUrl),
        };

        return this.rows.getRow(collection, rowRef);
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
