import { resolveBackendAsync } from "./backend";
import type { RowInput, RowRef } from "./schema";
import { normalizeRowRef } from "./row-reference";
import type { BackendClient, BackendKv } from "./types";

const SAVED_ROW_PREFIX = "putbase:saved-row:v2";

function normalizeStorageKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("Saved row key is required");
  }
  return normalized;
}

function savedRowKey(key: string): string {
  return `${SAVED_ROW_PREFIX}:${normalizeStorageKey(key)}`;
}

function resolveStoredRow(row: RowInput): string {
  return JSON.stringify(normalizeRowRef(row));
}

async function resolveSavedRowsKv(backend?: BackendClient): Promise<BackendKv | null> {
  return (await resolveBackendAsync(backend))?.kv ?? null;
}

async function deleteStoredRow(
  backend: BackendClient | undefined,
  entryKey: string,
): Promise<void> {
  const kv = await resolveSavedRowsKv(backend);
  if (!kv) {
    return;
  }

  await kv.delete(entryKey).catch(() => undefined);
}

export async function loadSavedRow(
  backend: BackendClient | undefined,
  key: string,
): Promise<RowRef | null> {
  const entryKey = savedRowKey(key);
  const kv = await resolveSavedRowsKv(backend);
  if (!kv) {
    return null;
  }

  const stored = await kv.get<unknown>(entryKey).catch(() => undefined);
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
  key: string,
  row: RowInput,
): Promise<void> {
  const kv = await resolveSavedRowsKv(backend);
  if (!kv) {
    return;
  }

  await kv.set(savedRowKey(key), resolveStoredRow(row)).catch(() => undefined);
}

export async function clearSavedRow(
  backend: BackendClient | undefined,
  key: string,
): Promise<void> {
  await deleteStoredRow(backend, savedRowKey(key));
}
