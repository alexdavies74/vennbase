import type { KV } from "@heyputer/puter.js";
import type { DogRowHandle } from "./schema";

export interface DogProfile {
  row: DogRowHandle;
}

const PROFILE_KEY = "woof:myDog";

type KvLike = Pick<KV, "get" | "set" | "del">;

export async function loadStoredTarget(kv: KvLike): Promise<string | null> {
  const value = await kv.get<unknown>(PROFILE_KEY);
  if (typeof value !== "string") {
    return null;
  }

  const target = value.trim();
  return target || null;
}

export async function saveStoredTarget(row: Pick<DogRowHandle, "target">, kv: KvLike): Promise<void> {
  await kv.set(PROFILE_KEY, row.target);
}

export async function clearProfile(kv: KvLike): Promise<void> {
  await kv.del(PROFILE_KEY);
}
