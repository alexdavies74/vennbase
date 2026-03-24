import type { RowInput, RowRef } from "./schema";
import { normalizeBaseUrl } from "./transport";

function hasEmbeddedRowRef<TCollection extends string>(
  row: RowInput<TCollection>,
): row is { ref: RowRef<TCollection> } {
  return "ref" in row;
}

export function normalizeRowRef<TCollection extends string>(
  row: RowInput<TCollection>,
): RowRef<TCollection> {
  const resolved = hasEmbeddedRowRef(row) ? row.ref : row;
  return {
    id: resolved.id,
    collection: resolved.collection,
    baseUrl: normalizeBaseUrl(resolved.baseUrl),
  };
}

export function normalizeParentRefs<TCollection extends string>(
  input: RowInput<TCollection> | RowInput<TCollection>[] | undefined,
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
