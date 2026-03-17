import type { AuthManager } from "./auth";
import { buildClassicWorkerScript } from "./worker/template";
import { resolveBackend } from "./backend";
import type { WorkerDeployment } from "@heyputer/puter.js";
import type { Identity } from "./identity";
import type { PutBaseOptions } from "./putbase";
import type { Transport } from "./transport";
import { stripTrailingSlash } from "./transport";
import type { BackendClient, DeployWorkerArgs } from "./types";

const FEDERATION_WORKER_ROOM_SENTINEL = "bootstrap";
const FEDERATION_WORKER_VERSION = 28;
const WORKER_METADATA_NAMESPACE = "putbase";
const LEGACY_WORKER_METADATA_NAMESPACE = `${"puter"}-${"fed"}`;
const FEDERATION_WORKER_VERSION_KV_PREFIX = `${WORKER_METADATA_NAMESPACE}:federation-worker-version:v2`;
const FEDERATION_WORKER_URL_KV_PREFIX = `${WORKER_METADATA_NAMESPACE}:federation-worker-url:v2`;
const LEGACY_FEDERATION_WORKER_VERSION_KV_PREFIX = `${LEGACY_WORKER_METADATA_NAMESPACE}:federation-worker-version:v2`;
const LEGACY_FEDERATION_WORKER_URL_KV_PREFIX = `${LEGACY_WORKER_METADATA_NAMESPACE}:federation-worker-url:v2`;
const FEDERATION_WORKER_DIR = `${WORKER_METADATA_NAMESPACE}/workers`;
const sharedFederationWorkerPromises = new Map<string, Promise<string>>();
const sharedFederationWorkerUrls = new Map<string, string>();

export class Provisioning {
  private federationWorkerUrl: string | null = null;
  private federationWorkerPromise: Promise<string> | null = null;
  private backend: BackendClient | undefined;

  constructor(
    private readonly options: Pick<PutBaseOptions, "appBaseUrl" | "backend" | "deployWorker">,
    private readonly transport: Transport,
    private readonly identity: Identity,
    private readonly auth: AuthManager,
  ) {
    this.backend = resolveBackend(options.backend);
  }

  setBackend(backend: BackendClient | undefined): void {
    this.backend = backend;
  }

  async ensureFederationWorkerForCurrentUser(): Promise<boolean> {
    if (!this.canDeployFederationWorker()) {
      return false;
    }

    const user = await this.identity.whoAmI();
    await this.getFederationWorkerUrl(user.username);
    return true;
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
      await this.saveFederationWorkerMetadata(username, appHostHash, storedUrl);
      return stripTrailingSlash(storedUrl);
    }

    const requiresUpgrade = storedVersion > 0 && storedVersion < FEDERATION_WORKER_VERSION;
    if (!requiresUpgrade) {
      const existingWorkerUrl = await this.loadExistingFederationWorkerUrl(workerName);
      if (existingWorkerUrl) {
        await this.saveFederationWorkerMetadata(username, appHostHash, existingWorkerUrl);
        return stripTrailingSlash(existingWorkerUrl);
      }
    }

    if (!this.canDeployFederationWorker()) {
      throw new Error(
        "Unable to provision federation worker: a compatible backend with workers.create is unavailable.",
      );
    }

    if (requiresUpgrade) {
      console.info(
        `[putbase] upgrading federation worker ${workerName} for ${username} on ${appHostname} from version ${storedVersion} to ${FEDERATION_WORKER_VERSION}`,
      );
    } else {
      console.info(
        `[putbase] deploying federation worker ${workerName} for ${username} on ${appHostname} at version ${FEDERATION_WORKER_VERSION}`,
      );
    }

    const ownerPublicKeyJwk = await this.auth.getPublicKeyJwk();
    const script = buildClassicWorkerScript({
      owner: username,
      ownerPublicKeyJwk,
    });

    const deployedWorkerUrl = await this.deployWorker({
      owner: username,
      roomId: FEDERATION_WORKER_ROOM_SENTINEL,
      roomName: "federation",
      ownerPublicKeyJwk,
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
    console.info(
      `[putbase] federation worker ready ${workerName} version ${FEDERATION_WORKER_VERSION} ${activeWorkerUrl}`,
    );
    await this.saveFederationWorkerMetadata(username, appHostHash, activeWorkerUrl);
    return activeWorkerUrl;
  }

  canDeployFederationWorker(): boolean {
    if (typeof this.options.deployWorker === "function") {
      return true;
    }

    this.backend = resolveBackend(this.backend);
    const workers = this.backend?.workers;
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

    this.backend = resolveBackend(this.backend);

    const backend = this.backend;
    if (!backend) {
      throw new Error("A compatible backend client is unavailable.");
    }

    const workerName = args.workerName ?? `${args.owner}-federation`;
    const workerFilePath = `${FEDERATION_WORKER_DIR}/${workerName}.js`;

    const workers = backend.workers;

    if (!workers?.create) {
      throw new Error("A compatible backend workers.create API is unavailable.");
    }

    try {
      await backend.fs.mkdir(FEDERATION_WORKER_DIR, {
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

      let deployment: WorkerDeployment;
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

      const discovered = await this.loadExistingFederationWorkerUrl(workerName);
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

  private legacyFederationWorkerVersionKey(username: string, appHostHash: string): string {
    return `${LEGACY_FEDERATION_WORKER_VERSION_KV_PREFIX}:${username}:${appHostHash}`;
  }

  private federationWorkerUrlKey(username: string, appHostHash: string): string {
    return `${FEDERATION_WORKER_URL_KV_PREFIX}:${username}:${appHostHash}`;
  }

  private legacyFederationWorkerUrlKey(username: string, appHostHash: string): string {
    return `${LEGACY_FEDERATION_WORKER_URL_KV_PREFIX}:${username}:${appHostHash}`;
  }

  private async loadFederationWorkerVersion(username: string, appHostHash: string): Promise<number> {
    this.backend = resolveBackend(this.backend);

    const kv = this.backend?.kv;
    if (!kv?.get) {
      return 0;
    }

    for (const key of [
      this.federationWorkerVersionKey(username, appHostHash),
      this.legacyFederationWorkerVersionKey(username, appHostHash),
    ]) {
      const value = await kv.get<unknown>(key).catch(() => undefined);
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
      }
    }

    return 0;
  }

  private async loadFederationWorkerUrl(username: string, appHostHash: string): Promise<string | null> {
    this.backend = resolveBackend(this.backend);

    const kv = this.backend?.kv;
    if (!kv?.get) {
      return null;
    }

    for (const key of [
      this.federationWorkerUrlKey(username, appHostHash),
      this.legacyFederationWorkerUrlKey(username, appHostHash),
    ]) {
      const value = await kv.get<unknown>(key).catch(() => undefined);
      if (typeof value === "string" && value.trim()) {
        return stripTrailingSlash(value.trim());
      }
    }

    return null;
  }

  private async loadExistingFederationWorkerUrl(workerName: string): Promise<string | null> {
    this.backend = resolveBackend(this.backend);

    const backend = this.backend;
    const workers = backend?.workers;

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
    this.backend = resolveBackend(this.backend);

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
