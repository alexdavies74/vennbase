import {
  canonicalize,
  decodeDataUrlJson,
  verifyEnvelope,
} from "../crypto";
import type {
  ApiError,
  InviteToken,
  Message,
  Room,
  RoomSnapshot,
  SignedWriteEnvelope,
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
  publicKeyUrl: string;
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
  signedBy: string;
}

export interface RoomWorkerDeps {
  kv: WorkerKv;
  fetchFn?: typeof fetch;
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
  "access-control-allow-headers": "content-type,x-puter-username",
};

const CORS_PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-puter-username",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const WORKER_ROUTE_SEGMENTS = new Set(["room", "messages", "join", "invite-token", "message"]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS,
  });
}

function isJsonWebKey(value: unknown): value is JsonWebKey {
  return (
    !!value &&
    typeof value === "object" &&
    "kty" in (value as Record<string, unknown>)
  );
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

function memberKey(roomId: string, username: string): string {
  return `room:${roomId}:memberkey:${username}`;
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

function sameJwk(left: JsonWebKey, right: JsonWebKey): boolean {
  return canonicalize(left) === canonicalize(right);
}

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

  private readonly fetchFn: typeof fetch;

  private readonly now: () => number;

  constructor(
    private readonly config: RoomWorkerConfig,
    deps: RoomWorkerDeps,
  ) {
    this.kv = deps.kv;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  async handle(request: Request): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_PREFLIGHT_HEADERS,
        });
      }

      const { pathname, searchParams } = new URL(request.url);

      if (request.method === "GET" && pathname === "/room") {
        return await this.getRoom(request);
      }

      if (request.method === "GET" && pathname === "/messages") {
        const sinceSequence = parseRequiredNonNegativeInteger(
          searchParams.get("sinceSequence"),
          "sinceSequence",
        );
        return await this.getMessages(request, sinceSequence);
      }

      if (request.method === "POST" && pathname === "/join") {
        return await this.join(request);
      }

      if (request.method === "POST" && pathname === "/invite-token") {
        return await this.createInviteToken(request);
      }

      if (request.method === "POST" && pathname === "/message") {
        return await this.postMessage(request);
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

  private async getRoom(request: Request): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(requester);

    const snapshot = await this.snapshot(request.url);
    return jsonResponse(200, snapshot);
  }

  private async getMessages(
    request: Request,
    sinceSequence: number,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(requester);

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
    const body = await parseJson<JoinRequest>(request);
    if (!body.username || !body.publicKeyUrl) {
      error(400, "BAD_REQUEST", "username and publicKeyUrl are required");
    }

    await this.ensureRoomMeta(request.url);

    const members = await this.getMembers();
    const isOwner = body.username === this.config.owner;
    const alreadyMember = members.includes(body.username);

    const fetchedKey = await this.fetchPublicKeyJwk(body.publicKeyUrl, body.username);

    if (alreadyMember) {
      const existing = await this.kv.get<JsonWebKey>(memberKey(this.config.roomId, body.username));
      if (!existing) {
        error(401, "UNAUTHORIZED", "Member key missing");
      }

      if (!sameJwk(existing, fetchedKey)) {
        error(409, "KEY_MISMATCH", "Public key cannot be changed for existing username");
      }

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
    await this.kv.set(memberKey(this.config.roomId, body.username), fetchedKey);

    return jsonResponse(200, await this.snapshot(request.url));
  }

  private async createInviteToken(request: Request): Promise<Response> {
    const requester = requesterFromHeader(request);
    const envelope = await parseJson<SignedWriteEnvelope<InvitePayload>>(request);

    await this.assertWriteAuthorization(requester, envelope, envelope.payload.invitedBy);

    if (envelope.payload.roomId !== this.config.roomId) {
      error(400, "BAD_REQUEST", "Envelope roomId does not match worker roomId");
    }

    await this.kv.set(tokenKey(this.config.roomId, envelope.payload.token), envelope.payload);

    return jsonResponse(200, {
      inviteToken: envelope.payload,
    });
  }

  private async postMessage(request: Request): Promise<Response> {
    const requester = requesterFromHeader(request);
    const envelope = await parseJson<SignedWriteEnvelope<MessagePayload>>(request);

    await this.assertWriteAuthorization(requester, envelope, envelope.payload.signedBy);

    if (envelope.payload.roomId !== this.config.roomId) {
      error(400, "BAD_REQUEST", "Envelope roomId does not match worker roomId");
    }

    const sequence = await this.nextMessageSequence();

    const message: Message = {
      ...envelope.payload,
      body: envelope.payload.body as Message["body"],
      sequence,
    };

    await this.kv.set(messageGlobalKey(this.config.roomId, message), message);

    return jsonResponse(200, {
      message,
    });
  }

  private async assertWriteAuthorization<TPayload extends object>(
    requester: string,
    envelope: SignedWriteEnvelope<TPayload>,
    signedBy: string,
  ): Promise<void> {
    if (requester !== envelope.signer.username) {
      error(401, "UNAUTHORIZED", "Requester and signer do not match");
    }

    if (signedBy !== envelope.signer.username) {
      error(401, "UNAUTHORIZED", "Payload signer claim does not match envelope signer");
    }

    await this.assertMember(envelope.signer.username);

    const publicKeyJwk = await this.kv.get<JsonWebKey>(
      memberKey(this.config.roomId, envelope.signer.username),
    );

    if (!publicKeyJwk) {
      error(401, "UNAUTHORIZED", "Signer key not found");
    }

    const verified = await verifyEnvelope(envelope, publicKeyJwk);
    if (!verified) {
      error(401, "INVALID_SIGNATURE", "Signature verification failed");
    }
  }

  private async assertMember(username: string): Promise<void> {
    const members = await this.getMembers();
    if (!members.includes(username)) {
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
    };
  }

  private async fetchPublicKeyJwk(publicKeyUrl: string, expectedUsername: string): Promise<JsonWebKey> {
    let payload: unknown;

    if (publicKeyUrl.startsWith("data:")) {
      payload = decodeDataUrlJson<unknown>(publicKeyUrl);
    } else {
      const fetchFn = this.fetchFn;
      const response = await fetchFn(publicKeyUrl);
      if (!response.ok) {
        error(400, "BAD_REQUEST", `Could not fetch public key document from ${publicKeyUrl}`);
      }
      payload = await response.json();
    }

    if (isJsonWebKey(payload)) {
      return payload;
    }

    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (
        typeof record.username === "string" &&
        record.username !== expectedUsername
      ) {
        error(401, "UNAUTHORIZED", "Public key document username does not match join username");
      }

      if (isJsonWebKey(record.publicKeyJwk)) {
        return record.publicKeyJwk;
      }
    }

    error(400, "BAD_REQUEST", "Public key document format is invalid");
  }
}
