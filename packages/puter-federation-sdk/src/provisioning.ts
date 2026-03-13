import { buildClassicWorkerScript } from "./worker/template";
import type { Identity } from "./identity";
import type { Transport } from "./transport";
import { stripTrailingSlash } from "./transport";
import type { BackendClient, DeployWorkerArgs, PuterFedRoomsOptions } from "./types";

const FEDERATION_WORKER_ROOM_SENTINEL = "bootstrap";
const FEDERATION_WORKER_VERSION = 12;
const FEDERATION_WORKER_VERSION_KV_PREFIX = "puter-fed:federation-worker-version:v2";
const FEDERATION_WORKER_URL_KV_PREFIX = "puter-fed:federation-worker-url:v2";
const sharedFederationWorkerPromises = new Map<string, Promise<string>>();
const sharedFederationWorkerUrls = new Map<string, string>();

export class Provisioning {
  private federationWorkerUrl: string | null = null;
  private federationWorkerPromise: Promise<string> | null = null;
  private backend: BackendClient | undefined;

  constructor(
    private readonly options: PuterFedRoomsOptions,
    private readonly transport: Transport,
    private readonly identity: Identity,
  ) {
    this.backend = options.puter;
  }

  setPuter(backend: BackendClient | undefined): void {
    this.backend = backend;
  }

  async ensureFederationWorkerForCurrentUser(): Promise<void> {
    if (!this.canDeployFederationWorker()) {
      return;
    }

    const user = await this.identity.whoAmI();
    await this.getFederationWorkerUrl(user.username);
  }

  async getFederationWorkerUrl(username: string): Promise<string> {
    if (this.federationWorkerUrl) {
      return this.federationWorkerUrl;
    }

    const appHostname = this.resolveAppHostname();
    const appHostHash = hashHostname(appHostname);
    const cacheKey = `${username}:${appHostHash}`;

    const sharedWorkerUrl = sharedFederationWorkerUrls.get(cacheKey);
    if (sharedWorkerUrl) {
      this.federationWorkerUrl = sharedWorkerUrl;
      return sharedWorkerUrl;
    }

    if (this.federationWorkerPromise) {
      return this.federationWorkerPromise;
    }

    const sharedPromise =
      sharedFederationWorkerPromises.get(cacheKey) ??
      this.createSharedFederationWorkerPromise(username, appHostname, appHostHash, cacheKey);

    const promise = sharedPromise
      .then((workerUrl) => {
        this.federationWorkerUrl = workerUrl;
        return workerUrl;
      })
      .finally(() => {
        if (this.federationWorkerPromise === promise) {
          this.federationWorkerPromise = null;
        }
      });

    this.federationWorkerPromise = promise;
    return promise;
  }

  private createSharedFederationWorkerPromise(
    username: string,
    appHostname: string,
    appHostHash: string,
    cacheKey: string,
  ): Promise<string> {
    const sharedPromise = this.ensureFederationWorkerUrl(username, appHostname, appHostHash)
      .then((workerUrl) => {
        sharedFederationWorkerUrls.set(cacheKey, workerUrl);
        return workerUrl;
      })
      .finally(() => {
        if (sharedFederationWorkerPromises.get(cacheKey) === sharedPromise) {
          sharedFederationWorkerPromises.delete(cacheKey);
        }
      });

    sharedFederationWorkerPromises.set(cacheKey, sharedPromise);
    return sharedPromise;
  }

  private async ensureFederationWorkerUrl(
    username: string,
    appHostname: string,
    appHostHash: string,
  ): Promise<string> {
    const workerName = this.federationWorkerName(username, appHostHash);

    const storedVersion = await this.loadFederationWorkerVersion(username, appHostHash);
    const storedUrl = await this.loadFederationWorkerUrl(username, appHostHash);
    if (storedUrl && storedVersion >= FEDERATION_WORKER_VERSION) {
      return stripTrailingSlash(storedUrl);
    }

    const existingWorkerUrl = await this.loadExistingFederationWorkerUrl(workerName);
    if (existingWorkerUrl) {
      await this.saveFederationWorkerMetadata(username, appHostHash, existingWorkerUrl);
      return stripTrailingSlash(existingWorkerUrl);
    }

    if (!this.canDeployFederationWorker()) {
      throw new Error("Unable to provision federation worker: puter.workers.create is unavailable.");
    }

    const script = buildClassicWorkerScript({ owner: username });

    const deployedWorkerUrl = await this.deployWorker({
      owner: username,
      roomId: FEDERATION_WORKER_ROOM_SENTINEL,
      roomName: "federation",
      workerName,
      workerVersion: FEDERATION_WORKER_VERSION,
      script,
      appHostname,
      appHostHash,
    });

    if (!deployedWorkerUrl) {
      throw new Error(
        `Unable to discover federation worker URL after deployment for "${workerName}" (${appHostname}, ${appHostHash}).`,
      );
    }

    const activeWorkerUrl = stripTrailingSlash(deployedWorkerUrl);
    await this.saveFederationWorkerMetadata(username, appHostHash, activeWorkerUrl);
    return activeWorkerUrl;
  }

  canDeployFederationWorker(): boolean {
    if (typeof this.options.deployWorker === "function") {
      return true;
    }

    if (!this.backend) {
      this.backend = (globalThis as { puter?: BackendClient }).puter;
    }

    const workers = this.backend?.workers as { create?: unknown } | undefined;
    return typeof workers?.create === "function";
  }

  private async deployWorker(args: DeployWorkerArgs): Promise<string | undefined> {
    if (this.options.deployWorker) {
      const maybeWorkerUrl = await this.options.deployWorker(args);
      if (typeof maybeWorkerUrl === "string" && maybeWorkerUrl.trim()) {
        return stripTrailingSlash(maybeWorkerUrl);
      }

      if (args.workerName) {
        return (await this.loadExistingFederationWorkerUrl(args.workerName)) ?? undefined;
      }

      return undefined;
    }

    if (!this.backend) {
      this.backend = (globalThis as { puter?: BackendClient }).puter;
    }

    const backend = this.backend;
    if (!backend) {
      throw new Error("Puter SDK is unavailable");
    }

    const workerName = args.workerName ?? `${args.owner}-federation`;
    const workerDir = "puter-fed/workers";
    const workerFilePath = `${workerDir}/${workerName}.js`;

    const workers = backend.workers as
      | {
          create?: (name: string, filePath: string) => Promise<{ url?: unknown }>;
          get?: (name: string) => Promise<{ url?: unknown } | null>;
        }
      | undefined;

    if (!workers?.create) {
      throw new Error("Puter workers.create is unavailable");
    }

    try {
      await backend.fs.mkdir(workerDir, {
        recursive: true,
        createMissingParents: true,
        overwrite: true,
        dedupeName: false,
      });
      await backend.fs.write(workerFilePath, args.script, {
        overwrite: true,
        createMissingParents: true,
        createMissingAncestors: true,
      });

      let deployment: { url?: unknown };
      try {
        deployment = await workers.create(workerName, workerFilePath);
      } catch (error) {
        if (isAlreadyInUseError(error)) {
          throw new Error(
            `Federation worker name collision for "${workerName}" (${args.appHostname ?? "unknown-host"}, ${args.appHostHash ?? "unknown-hash"}).`,
          );
        }

        throw error;
      }

      if (isAlreadyInUseError(deployment)) {
        throw new Error(
          `Federation worker name collision for "${workerName}" (${args.appHostname ?? "unknown-host"}, ${args.appHostHash ?? "unknown-hash"}).`,
        );
      }

      if (typeof deployment.url === "string" && deployment.url.trim()) {
        return stripTrailingSlash(deployment.url);
      }

      const discovered = workers.get
        ? await this.loadExistingFederationWorkerUrl(workerName)
        : null;
      return discovered ?? undefined;
    } catch (error) {
      console.error("[putbase] deployWorker failed", {
        error,
        workerName,
        workerFilePath,
      });
      throw error;
    }
  }

  private resolveAppHostname(): string {
    const appBaseUrl =
      this.options.appBaseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");
    const normalized = appBaseUrl.includes("://") ? appBaseUrl : `https://${appBaseUrl}`;
    return new URL(normalized).hostname.toLowerCase();
  }

  private federationWorkerName(username: string, appHostHash: string): string {
    return `${username}-${appHostHash}-federation`.toLowerCase();
  }

  private federationWorkerVersionKey(username: string, appHostHash: string): string {
    return `${FEDERATION_WORKER_VERSION_KV_PREFIX}:${username}:${appHostHash}`;
  }

  private federationWorkerUrlKey(username: string, appHostHash: string): string {
    return `${FEDERATION_WORKER_URL_KV_PREFIX}:${username}:${appHostHash}`;
  }

  private async loadFederationWorkerVersion(username: string, appHostHash: string): Promise<number> {
    if (!this.backend) {
      this.backend = (globalThis as { puter?: BackendClient }).puter;
    }

    const kv = this.backend?.kv;
    if (!kv?.get) {
      return 0;
    }

    const value = await kv
      .get<unknown>(this.federationWorkerVersionKey(username, appHostHash))
      .catch(() => undefined);
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }

    return 0;
  }

  private async loadFederationWorkerUrl(username: string, appHostHash: string): Promise<string | null> {
    if (!this.backend) {
      this.backend = (globalThis as { puter?: BackendClient }).puter;
    }

    const kv = this.backend?.kv;
    if (!kv?.get) {
      return null;
    }

    const value = await kv
      .get<unknown>(this.federationWorkerUrlKey(username, appHostHash))
      .catch(() => undefined);
    if (typeof value === "string" && value.trim()) {
      return stripTrailingSlash(value.trim());
    }

    return null;
  }

  private async loadExistingFederationWorkerUrl(workerName: string): Promise<string | null> {
    if (!this.backend) {
      this.backend = (globalThis as { puter?: BackendClient }).puter;
    }

    const backend = this.backend;
    const workers = backend?.workers as
      | {
          get?: (name: string) => Promise<{ url?: unknown } | null>;
        }
      | undefined;

    if (!workers?.get) {
      return null;
    }

    const existing = await workers.get(workerName).catch(() => null);
    if (existing && typeof existing.url === "string" && existing.url.trim()) {
      return stripTrailingSlash(existing.url);
    }

    return null;
  }

  private async saveFederationWorkerMetadata(
    username: string,
    appHostHash: string,
    workerUrl: string,
  ): Promise<void> {
    if (!this.backend) {
      this.backend = (globalThis as { puter?: BackendClient }).puter;
    }

    const kv = this.backend?.kv;
    if (!kv?.set) {
      return;
    }

    await Promise.all([
      kv.set(this.federationWorkerVersionKey(username, appHostHash), FEDERATION_WORKER_VERSION),
      kv.set(this.federationWorkerUrlKey(username, appHostHash), stripTrailingSlash(workerUrl)),
    ]).catch(() => undefined);
  }
}

function hashHostname(hostname: string): string {
  let hash = 0x811c9dc5;
  for (const char of hostname.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function isAlreadyInUseError(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const code = record.code;
  if (typeof code === "string" && code.toLowerCase() === "already_in_use") {
    return true;
  }

  const nested = record.error;
  if (!nested || typeof nested !== "object") {
    return false;
  }

  const nestedCode = (nested as { code?: unknown }).code;
  return typeof nestedCode === "string" && nestedCode.toLowerCase() === "already_in_use";
}
