import type { WorkerKv } from "./core";

interface KvEntry {
  key: string;
  value: unknown;
}

export class InMemoryKv implements WorkerKv {
  private readonly store = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | null> {
    if (!this.store.has(key)) {
      return null;
    }

    return structuredClone(this.store.get(key)) as T;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.store.set(key, structuredClone(value));
  }

  async list(prefix: string): Promise<KvEntry[]> {
    const entries: KvEntry[] = [];

    for (const [key, value] of this.store.entries()) {
      if (key.startsWith(prefix)) {
        entries.push({
          key,
          value: structuredClone(value),
        });
      }
    }

    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  }

  async incr(key: string, amount = 1): Promise<number> {
    const existing = this.store.get(key);
    const current = typeof existing === "number" && Number.isFinite(existing)
      ? existing
      : 0;
    const next = current + amount;
    this.store.set(key, next);
    return next;
  }
}
