import type { KV } from "@heyputer/puter.js";
import type { DogRowHandle } from "./schema";

export interface DogProfile {
  row: DogRowHandle;
}

const PROFILE_KEY = "woof:myDog";

type KvLike = Pick<KV, "get" | "set" | "del">;

export async function loadStoredWorkerUrl(kv: KvLike): Promise<string | null> {
  const value = await kv.get<unknown>(PROFILE_KEY);
  if (typeof value !== "string") {
    return null;
  }

  const workerUrl = value.trim();
  return workerUrl || null;
}

export async function saveStoredWorkerUrl(row: Pick<DogRowHandle, "workerUrl">, kv: KvLike): Promise<void> {
  await kv.set(PROFILE_KEY, row.workerUrl);
}

export async function clearProfile(kv: KvLike): Promise<void> {
  await kv.del(PROFILE_KEY);
}
