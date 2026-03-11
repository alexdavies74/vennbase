import {
  buildPublicKeyProofDocument,
  encodeProofDocumentAsDataUrl,
  exportPrivateJwk,
  exportPublicJwk,
  generateP256KeyPair,
  importP256KeyPair,
  signEnvelope,
} from "./crypto";
import { PuterFedError, toApiError } from "./errors";
import {
  createInviteLink,
  parseInviteInput,
  resolveWorkerUrl,
} from "./invite";
import { buildClassicWorkerScript } from "./worker/template";
import type {
  ApiError,
  CrdtConnectCallbacks,
  CrdtConnectOptions,
  CrdtConnection,
  DeployWorkerArgs,
  InviteToken,
  JoinOptions,
  JsonValue,
  Message,
  ParsedInviteInput,
  PuterFedRoomsOptions,
  Room,
  RoomSnapshot,
  RoomUser,
  SignedWriteEnvelope,
} from "./types";

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

interface StoredRoomSignerKey {
  version: 1;
  username: string;
  createdAt: number;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

const SIGNER_KEY_KV_PREFIX = "puter-fed:room-signer:v1";

export class PuterFedRooms {
  private readonly options: PuterFedRoomsOptions;

  private puter: PuterFedRoomsOptions["puter"];

  private fetchFn: typeof fetch;

  private identity: RoomUser | null = null;

  private keyPair: CryptoKeyPair | null = null;

  private publicKeyUrl: string | null = null;

  constructor(options: PuterFedRoomsOptions = {}) {
    this.options = options;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async init(): Promise<void> {
    this.puter = this.options.puter ?? (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    if (typeof this.fetchFn !== "function") {
      throw new Error("fetch is required");
    }

    const user = await this.whoAmI();

    if (!this.keyPair) {
      this.keyPair = await this.loadOrCreateKeyPair(user.username);
    }

    if (!this.publicKeyUrl) {
      const publicKeyJwk = await exportPublicJwk(this.keyPair.publicKey);
      const proofDocument = buildPublicKeyProofDocument(user.username, publicKeyJwk);
      this.publicKeyUrl = encodeProofDocumentAsDataUrl(proofDocument);
    }
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

  getPublicKeyUrl(): string {
    if (!this.publicKeyUrl) {
      throw new Error("Call init() before getting the public key URL");
    }

    return this.publicKeyUrl;
  }

  async createRoom(name: string): Promise<Room> {
    await this.init();

    const user = await this.whoAmI();
    const roomId = this.createId("room");
    const resolvedWorkerUrl = (this.options.workerResolver ?? resolveWorkerUrl)(
      user.username,
      roomId,
      this.options.workerBaseUrl,
    );

    const script = buildClassicWorkerScript({
      owner: user.username,
      roomId,
      roomName: name,
      workerUrl: resolvedWorkerUrl,
    });

    const deployedWorkerUrl = await this.deployWorker({
      owner: user.username,
      roomId,
      roomName: name,
      workerUrl: resolvedWorkerUrl,
      script,
    });

    const activeWorkerUrl = stripTrailingSlash(deployedWorkerUrl ?? resolvedWorkerUrl);

    await this.joinRoom(activeWorkerUrl, {
      publicKeyUrl: this.getPublicKeyUrl(),
    });

    const room = await this.getRoom(activeWorkerUrl);
    return {
      id: room.id,
      name: room.name,
      owner: room.owner,
      workerUrl: room.workerUrl,
      createdAt: room.createdAt,
    };
  }

  async joinRoom(workerUrl: string, options: JoinOptions): Promise<Room> {
    await this.init();

    const user = await this.whoAmI();

    await this.requestJson(`${stripTrailingSlash(workerUrl)}/join`, {
      method: "POST",
      body: {
        username: user.username,
        publicKeyUrl: options.publicKeyUrl,
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

  async createInviteToken(room: Room): Promise<InviteToken> {
    await this.init();

    const user = await this.whoAmI();

    if (!this.keyPair || !this.publicKeyUrl) {
      throw new Error("SDK was not initialized");
    }

    const payload: InviteToken = {
      token: this.createId("invite"),
      roomId: room.id,
      invitedBy: user.username,
      createdAt: Date.now(),
    };

    const envelope = await signEnvelope(
      "invite-token",
      payload,
      {
        username: user.username,
        publicKeyUrl: this.publicKeyUrl,
      },
      this.keyPair.privateKey,
    );

    const response = await this.requestJson<PostInviteResponse>(
      `${stripTrailingSlash(room.workerUrl)}/invite-token`,
      {
        method: "POST",
        body: envelope,
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

    const user = await this.whoAmI();

    if (!this.keyPair || !this.publicKeyUrl) {
      throw new Error("SDK was not initialized");
    }

    const payload: Omit<Message, "sequence"> = {
      id: this.createId("msg"),
      roomId: room.id,
      body,
      createdAt: Date.now(),
      signedBy: user.username,
    };

    const envelope: SignedWriteEnvelope<Omit<Message, "sequence">> = await signEnvelope(
      "message",
      payload,
      {
        username: user.username,
        publicKeyUrl: this.publicKeyUrl,
      },
      this.keyPair.privateKey,
    );

    const response = await this.requestJson<PostMessageResponse>(
      `${stripTrailingSlash(room.workerUrl)}/message`,
      {
        method: "POST",
        body: envelope,
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
    options: CrdtConnectOptions = {},
  ): CrdtConnection {
    let lastSequence = 0;
    let running = true;
    let inFlight: Promise<void> | null = null;

    const runTick = async (): Promise<void> => {
      try {
        const poll = await this.pollMessages(room, lastSequence);
        const messages = poll.messages;

        for (const message of messages) {
          callbacks.applyRemoteUpdate(message.body, message);
        }

        lastSequence = poll.latestSequence;

        const update = callbacks.produceLocalUpdate();
        if (update !== null) {
          const sent = await this.sendMessage(room, update);
          lastSequence = Math.max(lastSequence, sent.sequence);
        }
      } catch {
        // keep loop alive through transient failures
      }
    };

    // Coalesces concurrent calls: if a tick is already in-flight, returns that same promise
    const tick = (): Promise<void> => {
      if (!running) return Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = runTick().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };

    const scheduleNext = (): void => {
      if (running) {
        setTimeout(() => {
          tick().finally(scheduleNext);
        }, options.intervalMs ?? 5000);
      }
    };

    // Run first tick immediately, then schedule recurring ticks
    tick().finally(scheduleNext);

    return {
      disconnect() {
        running = false;
      },
      flush: tick,
    };
  }

  createInviteLink(room: Room, inviteToken: string): string {
    const appBaseUrl =
      this.options.appBaseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");

    return createInviteLink(room, inviteToken, appBaseUrl);
  }

  parseInviteInput(input: string): ParsedInviteInput {
    return parseInviteInput(input, (owner, roomId) =>
      (this.options.workerResolver ?? resolveWorkerUrl)(owner, roomId, this.options.workerBaseUrl),
    );
  }

  private async loadOrCreateKeyPair(username: string): Promise<CryptoKeyPair> {
    const restored = await this.loadKeyPairFromPuterKv(username);
    if (restored) {
      return restored;
    }

    const created = await generateP256KeyPair();
    await this.saveKeyPairToPuterKv(username, created);
    return created;
  }

  private async loadKeyPairFromPuterKv(username: string): Promise<CryptoKeyPair | null> {
    const kv = this.puter?.kv;
    if (!kv?.get) {
      return null;
    }

    const key = this.keyPairKvKey(username);
    const stored = await kv.get<unknown>(key).catch(() => undefined);
    if (!isStoredRoomSignerKey(stored, username)) {
      return null;
    }

    try {
      return await importP256KeyPair({
        publicKeyJwk: stored.publicKeyJwk,
        privateKeyJwk: stored.privateKeyJwk,
      });
    } catch (error) {
      console.warn("[puter-fed-sdk] Failed to import signer key from puter.kv", {
        error,
        username,
        key,
      });
      return null;
    }
  }

  private async saveKeyPairToPuterKv(username: string, keyPair: CryptoKeyPair): Promise<void> {
    const kv = this.puter?.kv;
    if (!kv?.set) {
      return;
    }

    const key = this.keyPairKvKey(username);
    try {
      const [publicKeyJwk, privateKeyJwk] = await Promise.all([
        exportPublicJwk(keyPair.publicKey),
        exportPrivateJwk(keyPair.privateKey),
      ]);

      await kv.set(key, {
        version: 1,
        username,
        createdAt: Date.now(),
        publicKeyJwk,
        privateKeyJwk,
      } satisfies StoredRoomSignerKey);
    } catch (error) {
      console.warn("[puter-fed-sdk] Failed to persist signer key in puter.kv", {
        error,
        username,
        key,
      });
    }
  }

  private keyPairKvKey(username: string): string {
    return `${SIGNER_KEY_KV_PREFIX}:${username}`;
  }

  private async requestJson<T>(
    url: string,
    options: {
      method: "GET" | "POST";
      body?: object;
    },
  ): Promise<T> {
    const user = await this.whoAmI();
    const fetchFn = this.fetchFn;

    const response = await fetchFn(url, {
      method: options.method,
      headers: {
        "content-type": "application/json",
        "x-puter-username": user.username,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const maybeApiError = await response
        .json()
        .catch((): ApiError => ({ code: "BAD_REQUEST", message: response.statusText }));
      throw new PuterFedError(toApiError(maybeApiError), response.status);
    }

    return (await response.json()) as T;
  }

  private async deployWorker(args: DeployWorkerArgs): Promise<string | undefined> {
    if (this.options.deployWorker) {
      await this.options.deployWorker(args);
      return undefined;
    }

    const puter = this.puter;
    if (!puter) {
      throw new Error("Puter SDK is unavailable");
    }

    const workerName = `${args.owner}-room-${args.roomId}`;
    const workerDir = "puter-fed/workers";
    const workerFilePath = `${workerDir}/${workerName}.js`;

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
      const deployment = await puter.workers.create(workerName, workerFilePath);
      return typeof deployment.url === "string" ? stripTrailingSlash(deployment.url) : undefined;
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
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/g, "");
}

function isStoredRoomSignerKey(value: unknown, expectedUsername: string): value is StoredRoomSignerKey {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<StoredRoomSignerKey>;
  return (
    record.version === 1 &&
    record.username === expectedUsername &&
    !!record.publicKeyJwk &&
    typeof record.publicKeyJwk === "object" &&
    !!record.privateKeyJwk &&
    typeof record.privateKeyJwk === "object"
  );
}
