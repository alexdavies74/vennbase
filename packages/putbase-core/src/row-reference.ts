import type { DbRowLocator, DbRowRef } from "./schema";
import { normalizeTarget } from "./transport";

export function toRowLocator<T extends Pick<DbRowLocator, "id" | "owner" | "target">>(
  row: T,
): DbRowLocator {
  return {
    id: row.id,
    owner: row.owner,
    target: normalizeTarget(row.target),
  };
}

export function toRowRef<TCollection extends string>(
  row: Pick<DbRowRef<TCollection>, "id" | "collection" | "owner" | "target">,
): DbRowRef<TCollection> {
  return {
    ...toRowLocator(row),
    collection: row.collection,
  };
}

export function normalizeParentRefs<TCollection extends string>(
  input: DbRowRef<TCollection> | DbRowRef<TCollection>[] | undefined,
): DbRowRef<TCollection>[] {
  if (!input) {
    return [];
  }

  return (Array.isArray(input) ? input : [input]).map((row) => toRowRef(row));
}
