import { resolveBackendAsync } from "./backend";
import type { RowRef } from "./schema";
import { normalizeRowRef } from "./row-reference";
import type { BackendClient } from "./types";

const PER_USER_ROW_PREFIX = "putbase:per-user-row:v1";
const inMemoryPerUserRows = new Map<string, string>();

type KvDeleteLike = {
  delete?: (key: string) => Promise<unknown>;
  del?: (key: string) => Promise<unknown>;
};

function normalizeStorageKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("Per-user row key is required");
  }
  return normalized;
}

function rememberedRowKey(username: string, key: string): string {
  return `${PER_USER_ROW_PREFIX}:${username}:${normalizeStorageKey(key)}`;
}

function resolveStoredRow(row: RowRef): string {
  return JSON.stringify(normalizeRowRef(row));
}

async function deleteStoredRow(
  backend: BackendClient | undefined,
  entryKey: string,
): Promise<void> {
  const resolvedBackend = await resolveBackendAsync(backend);
  const kv = resolvedBackend?.kv as (BackendClient["kv"] & KvDeleteLike) | undefined;
  if (typeof kv?.delete === "function") {
    await kv.delete(entryKey).catch(() => undefined);
    return;
  }

  if (typeof kv?.del === "function") {
    await kv.del(entryKey).catch(() => undefined);
    return;
  }

  inMemoryPerUserRows.delete(entryKey);
}

export async function loadRememberedPerUserRow(
  backend: BackendClient | undefined,
  username: string,
  key: string,
): Promise<RowRef | null> {
  const resolvedBackend = await resolveBackendAsync(backend);
  const entryKey = rememberedRowKey(username, key);
  const kv = resolvedBackend?.kv;
  const stored = kv?.get
    ? await kv.get<unknown>(entryKey).catch(() => undefined)
    : inMemoryPerUserRows.get(entryKey);
  if (typeof stored !== "string") {
    return null;
  }

  const normalized = stored.trim();
  if (!normalized) {
    await deleteStoredRow(backend, entryKey);
    return null;
  }

  try {
    const parsed = JSON.parse(normalized) as RowRef;
    return normalizeRowRef(parsed);
  } catch {
    // Old SDK versions stored bare row URLs; those no longer contain enough
    // metadata to reopen a row, so drop them instead of surfacing parse errors.
    await deleteStoredRow(backend, entryKey);
    return null;
  }
}

export async function rememberPerUserRow(
  backend: BackendClient | undefined,
  username: string,
  key: string,
  row: RowRef,
): Promise<void> {
  const resolvedBackend = await resolveBackendAsync(backend);
  const entryKey = rememberedRowKey(username, key);
  const value = resolveStoredRow(row);
  const kv = resolvedBackend?.kv;
  if (kv?.set) {
    await kv.set(entryKey, value).catch(() => undefined);
    return;
  }

  inMemoryPerUserRows.set(entryKey, value);
}

export async function clearRememberedPerUserRow(
  backend: BackendClient | undefined,
  username: string,
  key: string,
): Promise<void> {
  const entryKey = rememberedRowKey(username, key);
  await deleteStoredRow(backend, entryKey);
}
