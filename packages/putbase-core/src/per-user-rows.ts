import { resolveBackendAsync } from "./backend";
import type { RowInput, RowRef } from "./schema";
import { normalizeRowRef } from "./row-reference";
import type { BackendClient } from "./types";

const SAVED_ROW_PREFIX = "putbase:saved-row:v1";
const inMemorySavedRows = new Map<string, string>();

type KvDeleteLike = {
  delete?: (key: string) => Promise<unknown>;
  del?: (key: string) => Promise<unknown>;
};

function normalizeStorageKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("Saved row key is required");
  }
  return normalized;
}

function savedRowKey(username: string, key: string): string {
  return `${SAVED_ROW_PREFIX}:${username}:${normalizeStorageKey(key)}`;
}

function resolveStoredRow(row: RowInput): string {
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

  inMemorySavedRows.delete(entryKey);
}

export async function loadSavedRow(
  backend: BackendClient | undefined,
  username: string,
  key: string,
): Promise<RowRef | null> {
  const resolvedBackend = await resolveBackendAsync(backend);
  const entryKey = savedRowKey(username, key);
  const kv = resolvedBackend?.kv;
  const stored = kv?.get
    ? await kv.get<unknown>(entryKey).catch(() => undefined)
    : inMemorySavedRows.get(entryKey);
  if (typeof stored !== "string") {
    return null;
  }

  const normalized = stored.trim();
  if (!normalized) {
    await deleteStoredRow(backend, entryKey);
    return null;
  }

  const parsed = JSON.parse(normalized) as RowRef;
  return normalizeRowRef(parsed);
}

export async function saveRow(
  backend: BackendClient | undefined,
  username: string,
  key: string,
  row: RowInput,
): Promise<void> {
  const resolvedBackend = await resolveBackendAsync(backend);
  const entryKey = savedRowKey(username, key);
  const value = resolveStoredRow(row);
  const kv = resolvedBackend?.kv;
  if (kv?.set) {
    await kv.set(entryKey, value).catch(() => undefined);
    return;
  }

  inMemorySavedRows.set(entryKey, value);
}

export async function clearSavedRow(
  backend: BackendClient | undefined,
  username: string,
  key: string,
): Promise<void> {
  await deleteStoredRow(backend, savedRowKey(username, key));
}
