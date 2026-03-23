import type { RowRef } from "./schema";
import { normalizeBaseUrl } from "./transport";

export function normalizeRowRef<TCollection extends string>(
  row: Pick<RowRef<TCollection>, "id" | "collection" | "baseUrl">,
): RowRef<TCollection> {
  return {
    id: row.id,
    collection: row.collection,
    baseUrl: normalizeBaseUrl(row.baseUrl),
  };
}

export function normalizeParentRefs<TCollection extends string>(
  input: RowRef<TCollection> | RowRef<TCollection>[] | undefined,
): RowRef<TCollection>[] {
  if (!input) {
    return [];
  }

  return (Array.isArray(input) ? input : [input]).map((row) => normalizeRowRef(row));
}

export function sameRowRef(
  left: Pick<RowRef, "id" | "collection" | "baseUrl">,
  right: Pick<RowRef, "id" | "collection" | "baseUrl">,
): boolean {
  return left.id === right.id
    && left.collection === right.collection
    && normalizeBaseUrl(left.baseUrl) === normalizeBaseUrl(right.baseUrl);
}

export function rowRefKey(row: Pick<RowRef, "id" | "baseUrl">): string {
  return `${normalizeBaseUrl(row.baseUrl)}:${row.id}`;
}
