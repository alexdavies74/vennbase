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
  Message,
  ParsedInviteInput,
  PuterFedRoomsOptions,
  Room,
  RoomSnapshot,
  RoomUser,
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

type PuterWorkersExec = (
  workerUrl: string,
  init?: RequestInit,
) => Promise<Response>;

export class PuterFedRooms {
  private readonly options: PuterFedRoomsOptions;

  private puter: PuterFedRoomsOptions["puter"];

  private fetchFn: typeof fetch;

  private identity: RoomUser | null = null;

  constructor(options: PuterFedRoomsOptions = {}) {
    this.options = options;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async init(): Promise<void> {
    this.puter = this.options.puter ?? (globalThis as { puter?: PuterFedRoomsOptions["puter"] }).puter;
    if (typeof this.fetchFn !== "function" && !this.resolveWorkersExec()) {
      throw new Error("fetch is required when puter.workers.exec is unavailable");
    }

    await this.whoAmI();
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

    await this.joinRoom(activeWorkerUrl, {});

    const room = await this.getRoom(activeWorkerUrl);
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
