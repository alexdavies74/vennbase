import { resolveBackend } from "./backend";
import type { DbRowLocator } from "./schema";
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

function resolveStoredRow(row: Pick<DbRowLocator, "target">): string {
  const normalized = row.target.trim();
  if (!normalized) {
    throw new Error("Row target is required");
  }
  return normalized;
}

export async function loadRememberedPerUserRow(
  backend: BackendClient | undefined,
  username: string,
  key: string,
): Promise<Pick<DbRowLocator, "target"> | null> {
  const resolvedBackend = resolveBackend(backend);
  const entryKey = rememberedRowKey(username, key);
  const kv = resolvedBackend?.kv;
  const stored = kv?.get
    ? await kv.get<unknown>(entryKey).catch(() => undefined)
    : inMemoryPerUserRows.get(entryKey);
  if (typeof stored !== "string") {
    return null;
  }

  const normalized = stored.trim();
  return normalized ? { target: normalized } : null;
}

export async function rememberPerUserRow(
  backend: BackendClient | undefined,
  username: string,
  key: string,
  row: Pick<DbRowLocator, "target">,
): Promise<void> {
  const resolvedBackend = resolveBackend(backend);
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
  const resolvedBackend = resolveBackend(backend);
  const entryKey = rememberedRowKey(username, key);
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
