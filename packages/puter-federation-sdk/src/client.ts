import { PuterFedError, toApiError } from "./errors";
import {
  createInviteLink,
  parseInviteInput,
} from "./invite";
import { createAdaptivePoller } from "./polling";
import { buildClassicWorkerScript } from "./worker/template";
import type {
  ApiError,
  CrdtConnectCallbacks,
  CrdtConnection,
  DeployWorkerArgs,
  InviteToken,
  JoinOptions,
  Message,
  ParsedInviteInput,
  PuterFedRoomsOptions,
  Room,
  RoomSnapshot,
  RoomUser,
} from "./types";

interface GetInviteResponse {
  inviteToken: InviteToken | null;
}

interface PostInviteResponse {
  inviteToken: InviteToken;
}

interface PostMessageResponse {
  message: Message;
}

interface PollMessagesResponse {
  messages: Message[];
  latestSequence: number;
}

type PuterWorkersExec = (
  workerUrl: string,
  init?: RequestInit,
) => Promise<Response>;

const FEDERATION_WORKER_ROOM_SENTINEL = "bootstrap";
const FEDERATION_WORKER_VERSION = 12;
const FEDERATION_WORKER_VERSION_KV_PREFIX = "puter-fed:federation-worker-version:v2";
const FEDERATION_WORKER_URL_KV_PREFIX = "puter-fed:federation-worker-url:v2";

export class PuterFedRooms {
  private readonly options: PuterFedRoomsOptions;

  private puter: PuterFedRoomsOptions["puter"];

  private fetchFn: typeof fetch;

  private identity: RoomUser | null = null;

  private federationWorkerUrl: string | null = null;

  constructor(options: PuterFedRoomsOptions = {}) {
    this.options = options;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async init(): Promise<void> {
    this.puter = this.options.puter ?? (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    if (typeof this.fetchFn !== "function" && !this.resolveWorkersExec()) {
      throw new Error("fetch is required when puter.workers.exec is unavailable");
    }

    const user = await this.whoAmI();
    await this.ensureFederationWorkerOnInit(user.username);
  }

  async whoAmI(): Promise<RoomUser> {
    if (this.identity) {
      return this.identity;
    }

    if (this.options.identityProvider) {
      this.identity = await this.options.identityProvider();
      return this.identity;
    }

    const auth = this.puter?.auth;
    let candidate: { username?: string } | null = null;

    if (auth?.getUser) {
      candidate = await auth.getUser().catch(() => null);
    }

    if (!candidate?.username && auth?.whoami) {
      candidate = await auth.whoami().catch(() => candidate);
    }

    if (!candidate?.username && auth?.isSignedIn && auth?.signIn && !auth.isSignedIn()) {
      await auth.signIn().catch(() => null);
      candidate = await (auth.whoami?.() ?? auth.getUser?.() ?? Promise.resolve(null)).catch(
        () => candidate,
      );
    }

    if (!candidate && this.puter?.getUser) {
      candidate = await this.puter.getUser().catch(() => null);
    }

    const username = candidate?.username;
    if (!username) {
      throw new Error(
        "Unable to determine current Puter username. Import @heyputer/puter.js in the frontend and pass { puter } to PuterFedRooms.",
      );
    }

    this.identity = { username };
    return this.identity;
  }

  async createRoom(name: string): Promise<Room> {
    await this.init();

    const user = await this.whoAmI();
    const federationWorkerUrl = await this.getFederationWorkerUrl(user.username);
    const roomId = this.createId("room");
    const roomWorkerUrl = buildRoomWorkerUrl(federationWorkerUrl, roomId);

    await this.requestJson(`${federationWorkerUrl}/rooms`, {
      method: "POST",
      body: {
        roomId,
        roomName: name,
      },
    });

    await this.joinRoom(roomWorkerUrl, {});

    const room = await this.getRoom(roomWorkerUrl);
    return {
      id: room.id,
      name: room.name,
      owner: room.owner,
      workerUrl: room.workerUrl,
      createdAt: room.createdAt,
    };
  }

  async joinRoom(workerUrl: string, options: JoinOptions = {}): Promise<Room> {
    await this.init();

    const user = await this.whoAmI();

    await this.requestJson(`${stripTrailingSlash(workerUrl)}/join`, {
      method: "POST",
      body: {
        username: user.username,
        inviteToken: options.inviteToken,
      },
    });

    const room = await this.getRoom(workerUrl);
    return {
      id: room.id,
      name: room.name,
      owner: room.owner,
      workerUrl: room.workerUrl,
      createdAt: room.createdAt,
    };
  }

  async getExistingInviteToken(room: Room): Promise<InviteToken | null> {
    await this.init();
    const response = await this.requestJson<GetInviteResponse>(
      `${stripTrailingSlash(room.workerUrl)}/invite-token`,
      { method: "GET" },
    );
    return response.inviteToken;
  }

  async createInviteToken(room: Room): Promise<InviteToken> {
    await this.init();
    const user = await this.whoAmI();

    const payload: InviteToken = {
      token: this.createId("invite"),
      roomId: room.id,
      invitedBy: user.username,
      createdAt: Date.now(),
    };

    const response = await this.requestJson<PostInviteResponse>(
      `${stripTrailingSlash(room.workerUrl)}/invite-token`,
      {
        method: "POST",
        body: payload,
      },
    );

    return response.inviteToken;
  }

  async listMembers(room: Room): Promise<string[]> {
    const snapshot = await this.getRoom(room.workerUrl);
    return snapshot.members;
  }

  async getRoom(workerUrl: string): Promise<RoomSnapshot> {
    return this.requestJson<RoomSnapshot>(`${stripTrailingSlash(workerUrl)}/room`, {
      method: "GET",
    });
  }

  async sendMessage(room: Room, body: Message["body"]): Promise<Message> {
    await this.init();

    const payload: Omit<Message, "sequence" | "signedBy"> = {
      id: this.createId("msg"),
      roomId: room.id,
      body,
      createdAt: Date.now(),
    };

    const response = await this.requestJson<PostMessageResponse>(
      `${stripTrailingSlash(room.workerUrl)}/message`,
      {
        method: "POST",
        body: payload,
      },
    );

    return response.message;
  }

  async pollMessages(room: Room, sinceSequence: number): Promise<PollMessagesResponse> {
    const response = await this.requestJson<PollMessagesResponse>(
      `${stripTrailingSlash(room.workerUrl)}/messages?sinceSequence=${encodeURIComponent(String(sinceSequence))}`,
      {
        method: "GET",
      },
    );

    response.messages.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );

    return response;
  }

  connectCrdt(
    room: Room,
    callbacks: CrdtConnectCallbacks,
  ): CrdtConnection {
    let lastSequence = 0;
    const poller = createAdaptivePoller({
      run: async ({ markActivity }) => {
        const poll = await this.pollMessages(room, lastSequence);
        const messages = poll.messages;

        for (const message of messages) {
          callbacks.applyRemoteUpdate(message.body, message);
        }

        if (messages.length > 0) {
          markActivity();
        }

        lastSequence = poll.latestSequence;

        const update = callbacks.produceLocalUpdate();
        if (update !== null) {
          const sent = await this.sendMessage(room, update);
          lastSequence = Math.max(lastSequence, sent.sequence);
          markActivity();
        }
      },
    });

    return {
      disconnect() {
        poller.disconnect();
      },
      flush: () => poller.refresh(),
    };
  }

  createInviteLink(room: Room, inviteToken: string): string {
    const appBaseUrl =
      this.options.appBaseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");

    return createInviteLink(room, inviteToken, appBaseUrl);
  }

  parseInviteInput(input: string): ParsedInviteInput {
    return parseInviteInput(input);
  }

  private async requestJson<T>(
    url: string,
    options: {
      method: "GET" | "POST";
      body?: object;
    },
  ): Promise<T> {
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const workersExec = this.resolveWorkersExec();

    const response = workersExec
      ? await workersExec(url, {
          method: options.method,
          headers: {
            "content-type": "application/json",
          },
          body,
        })
      : await this.requestJsonViaFetch(url, options.method, body);

    if (!response.ok) {
      const maybeApiError = await response
        .json()
        .catch((): ApiError => ({ code: "BAD_REQUEST", message: response.statusText }));
      throw new PuterFedError(toApiError(maybeApiError), response.status);
    }

    return (await response.json()) as T;
  }

  private async requestJsonViaFetch(
    url: string,
    method: "GET" | "POST",
    body?: string,
  ): Promise<Response> {
    const user = await this.whoAmI();
    const fetchFn = this.fetchFn;

    return fetchFn(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-puter-username": user.username,
      },
      body,
    });
  }

  private resolveWorkersExec(): PuterWorkersExec | null {
    if (!this.puter) {
      this.puter = this.options.puter ?? (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    }

    const exec = (this.puter?.workers as { exec?: unknown } | undefined)?.exec;
    return typeof exec === "function" ? (exec as PuterWorkersExec) : null;
  }

  private async getFederationWorkerUrl(username: string): Promise<string> {
    if (this.federationWorkerUrl) {
      return this.federationWorkerUrl;
    }

    const appHostname = this.resolveAppHostname();
    const appHostHash = hashHostname(appHostname);

    this.federationWorkerUrl = await this.ensureFederationWorkerUrl(username, appHostname, appHostHash);
    return this.federationWorkerUrl;
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

  private async ensureFederationWorkerOnInit(username: string): Promise<void> {
    if (!this.canDeployFederationWorker()) {
      return;
    }

    try {
      await this.getFederationWorkerUrl(username);
    } catch (error) {
      console.warn("[puter-fed-sdk] failed to ensure federation worker during init", {
        username,
        error,
      });
    }
  }

  private canDeployFederationWorker(): boolean {
    if (typeof this.options.deployWorker === "function") {
      return true;
    }

    const workers = this.puter?.workers as { create?: unknown } | undefined;
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

    const puter = this.puter;
    if (!puter) {
      throw new Error("Puter SDK is unavailable");
    }

    const workerName = args.workerName ?? `${args.owner}-federation`;
    const workerDir = "puter-fed/workers";
    const workerFilePath = `${workerDir}/${workerName}.js`;

    const workers = puter.workers as
      | {
          create?: (name: string, filePath: string) => Promise<{ url?: unknown }>;
          get?: (name: string) => Promise<{ url?: unknown } | null>;
        }
      | undefined;

    if (!workers?.create) {
      throw new Error("Puter workers.create is unavailable");
    }

    try {
      await puter.fs.mkdir(workerDir, {
        recursive: true,
        createMissingParents: true,
        overwrite: true,
        dedupeName: false,
      });
      await puter.fs.write(workerFilePath, args.script, {
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
      console.error("[puter-fed-sdk] deployWorker failed", {
        error,
        workerName,
        workerFilePath,
      });
      throw error;
    }
  }

  private createId(prefix: string): string {
    const random = crypto.randomUUID().replace(/-/g, "");
    return `${prefix}_${random}`;
  }

  private resolveAppHostname(): string {
    const appBaseUrl =
      this.options.appBaseUrl
      ?? (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");
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
    const kv = this.puter?.kv;
    if (!kv?.get) {
      return 0;
    }

    const value = await kv.get<unknown>(this.federationWorkerVersionKey(username, appHostHash))
      .catch(() => undefined);
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }

    return 0;
  }

  private async loadFederationWorkerUrl(username: string, appHostHash: string): Promise<string | null> {
    const kv = this.puter?.kv;
    if (!kv?.get) {
      return null;
    }

    const value = await kv.get<unknown>(this.federationWorkerUrlKey(username, appHostHash)).catch(() => undefined);
    if (typeof value === "string" && value.trim()) {
      return stripTrailingSlash(value.trim());
    }

    return null;
  }

  private async loadExistingFederationWorkerUrl(workerName: string): Promise<string | null> {
    const puter = this.puter;
    const workers = puter?.workers as
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
    const kv = this.puter?.kv;
    if (!kv?.set) {
      return;
    }

    await Promise.all([
      kv.set(this.federationWorkerVersionKey(username, appHostHash), FEDERATION_WORKER_VERSION),
      kv.set(this.federationWorkerUrlKey(username, appHostHash), stripTrailingSlash(workerUrl)),
    ]).catch(() => undefined);
  }
}

function buildRoomWorkerUrl(federationWorkerBaseUrl: string, roomId: string): string {
  return `${stripTrailingSlash(federationWorkerBaseUrl)}/rooms/${encodeURIComponent(roomId)}`;
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/g, "");
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
