import type { BackendClient } from "./types";

let ambientBackendPromise: Promise<BackendClient | undefined> | null = null;

export function resolveBackend(explicitBackend?: BackendClient): BackendClient | undefined {
  return explicitBackend ?? (globalThis as { puter?: BackendClient }).puter;
}

export async function resolveBackendAsync(explicitBackend?: BackendClient): Promise<BackendClient | undefined> {
  const resolved = resolveBackend(explicitBackend);
  if (resolved || explicitBackend || typeof window === "undefined") {
    return resolved;
  }

  if (ambientBackendPromise) {
    return ambientBackendPromise;
  }

  const promise = import("@heyputer/puter.js")
    .catch(() => undefined)
    .then(() => resolveBackend());

  ambientBackendPromise = promise.finally(() => {
    if (ambientBackendPromise === promise) {
      ambientBackendPromise = null;
    }
  });

  return ambientBackendPromise;
}
