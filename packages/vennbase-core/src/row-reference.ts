import { isCurrentUser, toRowRef, type CurrentUser, type RowInput, type RowRef } from "./schema.js";
import { normalizeBaseUrl } from "./transport.js";

export function normalizeRowRef<TCollection extends string>(
  row: RowInput<TCollection>,
): RowRef<TCollection> {
  const resolved = toRowRef(row);
  return {
    id: resolved.id,
    collection: resolved.collection,
    baseUrl: normalizeBaseUrl(resolved.baseUrl),
  };
}

export function normalizeParentRefs<TCollection extends string>(
  input: RowInput<TCollection> | CurrentUser | Array<RowInput<TCollection> | CurrentUser> | undefined,
): RowRef<TCollection>[] {
  if (!input) {
    return [];
  }

  return (Array.isArray(input) ? input : [input]).map((row) => {
    if (isCurrentUser(row)) {
      throw new Error("CURRENT_USER must be resolved before normalizing parent refs.");
    }

    return normalizeRowRef(row);
  });
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
