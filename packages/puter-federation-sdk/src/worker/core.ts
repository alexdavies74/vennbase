import type {
  ApiError,
  InviteToken,
  Message,
  Room,
  RoomSnapshot,
} from "../types";

interface KvEntry {
  key: string;
  value: unknown;
}

export interface WorkerKv {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  list(prefix: string): Promise<KvEntry[]>;
  incr(key: string, amount?: number): Promise<number>;
}

export interface RoomWorkerConfig {
  roomId: string;
  roomName: string;
  owner: string;
  workerUrl: string;
}

interface JoinRequest {
  username: string;
  inviteToken?: string;
}

interface InvitePayload {
  token: string;
  roomId: string;
  invitedBy: string;
  createdAt: number;
}

interface MessagePayload {
  id: string;
  roomId: string;
  body: unknown;
  createdAt: number;
}

export interface RoomWorkerDeps {
  kv: WorkerKv;
  now?: () => number;
}

class WorkerApiError extends Error {
  readonly status: number;
  readonly apiError: ApiError;

  constructor(status: number, apiError: ApiError) {
    super(apiError.message);
    this.name = "WorkerApiError";
    this.status = status;
    this.apiError = apiError;
  }
}

const CORS_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-puter-username,puter-auth",
};

const CORS_PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-puter-username,puter-auth",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const WORKER_ROUTE_SEGMENTS = new Set(["room", "messages", "join", "invite-token", "message", "is-member", "parent-rooms"]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS,
  });
}

function error(status: number, code: ApiError["code"], message: string): never {
  throw new WorkerApiError(status, {
    code,
    message,
  });
}

async function parseJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    error(400, "BAD_REQUEST", "Request body must be valid JSON");
  }
}

function requesterFromHeader(request: Request): string {
  const requester = request.headers.get("x-puter-username");
  if (!requester) {
    error(401, "UNAUTHORIZED", "Missing x-puter-username");
  }

  return requester;
}

function messageGlobalKey(roomId: string, message: Pick<Message, "createdAt" | "id">): string {
  return `room:${roomId}:global_message:${message.createdAt}:${message.id}`;
}

function tokenKey(roomId: string, token: string): string {
  return `room:${roomId}:invite_token:${token}`;
}

function roomMetaKey(roomId: string): string {
  return `room:${roomId}:meta`;
}

function roomMembersKey(roomId: string): string {
  return `room:${roomId}:members`;
}

function roomGlobalMessagePrefix(roomId: string): string {
  return `room:${roomId}:global_message:`;
}

function roomMessageSequenceKey(roomId: string): string {
  return `room:${roomId}:global_message_sequence`;
}

function roomParentRoomsKey(roomId: string): string {
  return `room:${roomId}:parent_rooms`;
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/g, "");
}

type WorkersExec = (url: string, init?: RequestInit) => Promise<Response>;

interface WorkerRequestContext {
  workersExec: WorkersExec;
}

const DEFAULT_PARENT_ROOM_TTL = 5;

function parseRequiredNonNegativeInteger(value: string | null, name: string): number {
  if (value === null) {
    error(400, "BAD_REQUEST", `${name} is required`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    error(400, "BAD_REQUEST", `${name} must be a non-negative number`);
  }

  return Math.floor(parsed);
}

function inferWorkerUrlFromRequest(requestUrl: string): string {
  const url = new URL(requestUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (lastSegment && WORKER_ROUTE_SEGMENTS.has(lastSegment)) {
    segments.pop();
  }

  const workerPath = segments.length > 0 ? `/${segments.join("/")}` : "";
  return `${url.origin}${workerPath}`;
}

export class RoomWorker {
  private readonly kv: WorkerKv;

  private readonly now: () => number;

  constructor(
    private readonly config: RoomWorkerConfig,
    deps: RoomWorkerDeps,
  ) {
    this.kv = deps.kv;
    this.now = deps.now ?? (() => Date.now());
  }

  async handle(request: Request, ctx: WorkerRequestContext): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_PREFLIGHT_HEADERS,
        });
      }

      const { pathname, searchParams } = new URL(request.url);

      if (request.method === "GET" && pathname === "/room") {
        return await this.getRoom(request, ctx);
      }

      if (request.method === "GET" && pathname === "/messages") {
        const sinceSequence = parseRequiredNonNegativeInteger(
          searchParams.get("sinceSequence"),
          "sinceSequence",
        );
        return await this.getMessages(request, sinceSequence, ctx);
      }

      if (request.method === "POST" && pathname === "/join") {
        return await this.join(request);
      }

      if (request.method === "POST" && pathname === "/invite-token") {
        return await this.createInviteToken(request, ctx);
      }

      if (request.method === "POST" && pathname === "/message") {
        return await this.postMessage(request, ctx);
      }

      if (request.method === "GET" && pathname === "/is-member") {
        return await this.isMember(request, ctx);
      }

      return jsonResponse(404, {
        code: "BAD_REQUEST",
        message: "Endpoint not found",
      });
    } catch (err) {
      if (err instanceof WorkerApiError) {
        return jsonResponse(err.status, err.apiError);
      }

      const message = err instanceof Error ? err.message : "Unknown server error";
      return jsonResponse(500, {
        code: "BAD_REQUEST",
        message,
      });
    }
  }

  private async getRoom(request: Request, ctx: WorkerRequestContext): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(requester, ctx);

    const snapshot = await this.snapshot(request.url);
    return jsonResponse(200, snapshot);
  }

  private async getMessages(
    request: Request,
    sinceSequence: number,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(requester, ctx);

    const currentSequence = await this.getMessageSequence();
    if (sinceSequence >= currentSequence) {
      return jsonResponse(200, {
        messages: [],
        latestSequence: currentSequence,
      });
    }

    const messageEntries = await this.kv.list(roomGlobalMessagePrefix(this.config.roomId));

    const messages = messageEntries
      .map((entry) => entry.value as Message)
      .filter((message) => message.sequence > sinceSequence)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

    const latestSequence = messages.reduce(
      (highest, message) => Math.max(highest, message.sequence),
      sinceSequence,
    );

    return jsonResponse(200, {
      messages,
      latestSequence,
    });
  }

  private async join(request: Request): Promise<Response> {
    const requester = requesterFromHeader(request);
    const body = await parseJson<JoinRequest>(request);
    if (!body.username) {
      error(400, "BAD_REQUEST", "username is required");
    }

    if (body.username !== requester) {
      error(401, "UNAUTHORIZED", "Join username does not match authenticated requester");
    }

    await this.ensureRoomMeta(request.url);

    const members = await this.getMembers();
    const isOwner = body.username === this.config.owner;
    const alreadyMember = members.includes(body.username);

    if (alreadyMember) {
      return jsonResponse(200, await this.snapshot(request.url));
    }

    if (!isOwner) {
      if (!body.inviteToken) {
        error(401, "INVITE_REQUIRED", "Invite token is required for non-owner first join");
      }

      const invite = await this.kv.get<InviteToken>(tokenKey(this.config.roomId, body.inviteToken));
      if (!invite || invite.roomId !== this.config.roomId) {
        error(401, "INVITE_REQUIRED", "Invite token is invalid");
      }
    }

    members.push(body.username);
    await this.kv.set(roomMembersKey(this.config.roomId), members);

    return jsonResponse(200, await this.snapshot(request.url));
  }

  private async createInviteToken(request: Request, ctx: WorkerRequestContext): Promise<Response> {
    const requester = requesterFromHeader(request);
    const payload = await parseJson<InvitePayload>(request);

    await this.assertMember(requester, ctx);

    if (payload.roomId !== this.config.roomId) {
      error(400, "BAD_REQUEST", "Payload roomId does not match worker roomId");
    }

    const inviteToken: InviteToken = {
      token: payload.token,
      roomId: payload.roomId,
      invitedBy: requester,
      createdAt: payload.createdAt,
    };

    await this.kv.set(tokenKey(this.config.roomId, inviteToken.token), inviteToken);

    return jsonResponse(200, {
      inviteToken,
    });
  }

  private async postMessage(request: Request, ctx: WorkerRequestContext): Promise<Response> {
    const requester = requesterFromHeader(request);
    const payload = await parseJson<MessagePayload>(request);

    await this.assertMember(requester, ctx);

    if (payload.roomId !== this.config.roomId) {
      error(400, "BAD_REQUEST", "Payload roomId does not match worker roomId");
    }

    const sequence = await this.nextMessageSequence();

    const message: Message = {
      ...payload,
      body: payload.body as Message["body"],
      signedBy: requester,
      sequence,
    };

    await this.kv.set(messageGlobalKey(this.config.roomId, message), message);

    return jsonResponse(200, {
      message,
    });
  }

  private async isMember(request: Request, ctx: WorkerRequestContext): Promise<Response> {
    const requester = requesterFromHeader(request);
    const ttlParam = new URL(request.url).searchParams.get("ttl");
    const ttl = ttlParam !== null ? Math.max(0, Math.floor(Number(ttlParam))) : undefined;
    await this.assertMember(requester, ctx, ttl );
    return jsonResponse(200, { isMember: true });
  }

  private async getParentRoomUrls(): Promise<string[]> {
    return (await this.kv.get<string[]>(roomParentRoomsKey(this.config.roomId))) ?? [];
  }

  private async assertMember(username: string, ctx: WorkerRequestContext, ttl: number = DEFAULT_PARENT_ROOM_TTL): Promise<void> {
    const members = await this.getMembers();
    if (members.includes(username)) return;

    const parentRoomUrls = await this.getParentRoomUrls();
    if (ttl === 0 || parentRoomUrls.length === 0) {
      error(401, "UNAUTHORIZED", "Members only");
    }

    const checks = parentRoomUrls.map(async (parentUrl): Promise<boolean> => {
      try {
        const res = await ctx.workersExec(
          `${stripTrailingSlash(parentUrl)}/is-member?ttl=${ttl - 1}`,
          { method: "GET" },
        );
        return res.ok;
      } catch {
        return false;
      }
    });

    if (!(await Promise.all(checks)).some(Boolean)) {
      error(401, "UNAUTHORIZED", "Members only");
    }
  }

  private async getMembers(): Promise<string[]> {
    const stored = await this.kv.get<string[]>(roomMembersKey(this.config.roomId));
    return stored ?? [];
  }

  private async getMessageSequence(): Promise<number> {
    const stored = await this.kv.get<number>(roomMessageSequenceKey(this.config.roomId));
    if (typeof stored !== "number" || !Number.isFinite(stored) || stored < 0) {
      return 0;
    }

    return Math.floor(stored);
  }

  private async nextMessageSequence(): Promise<number> {
    const key = roomMessageSequenceKey(this.config.roomId);
    const sequence = await this.kv.incr(key, 1);
    if (!Number.isFinite(sequence) || sequence < 1) {
      error(500, "BAD_REQUEST", "kv.incr returned an invalid sequence");
    }

    return Math.floor(sequence);
  }

  private async ensureRoomMeta(requestUrl?: string): Promise<void> {
    const key = roomMetaKey(this.config.roomId);
    const inferredWorkerUrl = requestUrl ? inferWorkerUrlFromRequest(requestUrl) : undefined;
    const existing = await this.kv.get<Room>(key);
    if (existing) {
      if (inferredWorkerUrl && existing.workerUrl !== inferredWorkerUrl) {
        await this.kv.set(key, {
          ...existing,
          workerUrl: inferredWorkerUrl,
        });
      }
      return;
    }

    const room: Room = {
      id: this.config.roomId,
      name: this.config.roomName,
      owner: this.config.owner,
      workerUrl: inferredWorkerUrl ?? this.config.workerUrl,
      createdAt: this.now(),
    };

    await this.kv.set(key, room);
  }

  private async snapshot(requestUrl?: string): Promise<RoomSnapshot> {
    await this.ensureRoomMeta(requestUrl);

    const room = await this.kv.get<Room>(roomMetaKey(this.config.roomId));
    if (!room) {
      error(400, "BAD_REQUEST", "Room metadata missing");
    }

    const members = await this.getMembers();
    return {
      ...room,
      members,
      parentRooms: await this.getParentRoomUrls(),
    };
  }
}
