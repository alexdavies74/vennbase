import { encodeCompositeFieldValues } from "../db/key-encoding";
import type {
  ApiError,
  InviteToken,
  JsonValue,
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
  delete?(key: string): Promise<void>;
}

export interface RoomWorkerConfig {
  owner: string;
  workerUrl: string;
}

interface CreateRoomRequest {
  roomId: string;
  roomName: string;
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

type MemberRole = "admin" | "writer" | "reader";

interface GetFieldsResponse {
  fields: Record<string, JsonValue>;
  collection: string | null;
}

interface PostFieldsRequest {
  fields: Record<string, JsonValue>;
  merge?: boolean;
  collection?: string;
}

interface ChildSchemaPayload {
  indexes?: Record<string, { fields?: string[] }>;
}

interface RegisterChildRequest {
  childRowId: string;
  childOwner: string;
  childWorkerUrl: string;
  collection: string;
  fields?: Record<string, JsonValue>;
  schema?: ChildSchemaPayload;
}

interface UnregisterChildRequest {
  childRowId: string;
  childOwner: string;
  collection: string;
}

interface UpdateIndexRequest {
  childRowId: string;
  childOwner: string;
  childWorkerUrl?: string;
  collection: string;
  fields: Record<string, JsonValue>;
}

interface ParentLinkRequest {
  parentWorkerUrl: string;
}

interface MemberMutationRequest {
  username: string;
  role?: MemberRole;
}

interface ChildCollectionSchema {
  indexes: Record<string, { fields: string[] }>;
}

interface ChildEntry {
  rowId: string;
  owner: string;
  workerUrl: string;
  collection: string;
  fields: Record<string, JsonValue>;
  addedAt: number;
  updatedAt: number;
  active: boolean;
}

interface IndexEntry {
  rowId: string;
  owner: string;
  workerUrl: string;
  collection: string;
  fields: Record<string, JsonValue>;
  updatedAt: number;
  active: boolean;
}

interface EffectiveMember {
  username: string;
  role: MemberRole;
  via: "direct" | { id: string; collection: string; owner: string; workerUrl: string };
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

const DEFAULT_PARENT_ROOM_TTL = 5;
const MAX_QUERY_LIMIT = 200;

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
  const requester = request.headers.get("x-puter-username")?.trim();
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

function roomMemberRolesKey(roomId: string): string {
  return `row:${roomId}:member_roles`;
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

function rowFieldsKey(rowId: string): string {
  return `row:${rowId}:fields`;
}

function rowCollectionKey(rowId: string): string {
  return `row:${rowId}:collection`;
}

function rowChildSchemaKey(parentId: string, collection: string): string {
  return `row:${parentId}:child_schema:${collection}`;
}

function rowChildPrefix(parentId: string, collection: string): string {
  return `row:${parentId}:child:${collection}:`;
}

function rowChildKey(parentId: string, collection: string, childOwner: string, childRowId: string): string {
  return `${rowChildPrefix(parentId, collection)}${childOwner}:${childRowId}`;
}

function rowIndexPrefix(parentId: string, collection: string, indexName: string): string {
  return `row:${parentId}:idx:${collection}:${indexName}:`;
}

function rowIndexCollectionPrefix(parentId: string, collection: string): string {
  return `row:${parentId}:idx:${collection}:`;
}

function rowIndexKey(
  parentId: string,
  collection: string,
  indexName: string,
  encodedValue: string,
  childOwner: string,
  childRowId: string,
): string {
  return `${rowIndexPrefix(parentId, collection, indexName)}${encodedValue}:${childOwner}:${childRowId}`;
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/g, "");
}

function buildRoomWorkerUrl(workerBaseUrl: string, roomId: string): string {
  return `${stripTrailingSlash(workerBaseUrl)}/rooms/${encodeURIComponent(roomId)}`;
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

function parseOptionalNonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    error(400, "BAD_REQUEST", "Value must be a non-negative number");
  }

  return Math.floor(parsed);
}

interface RoomRoute {
  roomId: string;
  endpoint: string;
  workerBasePath: string;
}

function parseRoomRoute(pathname: string): RoomRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");
  if (roomsIndex < 0 || roomsIndex + 2 >= segments.length || roomsIndex + 3 !== segments.length) {
    return null;
  }

  return {
    roomId: decodeURIComponent(segments[roomsIndex + 1]),
    endpoint: segments[roomsIndex + 2],
    workerBasePath: roomsIndex > 0 ? `/${segments.slice(0, roomsIndex).join("/")}` : "",
  };
}

function isRoomsCollectionPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");
  return roomsIndex >= 0 && roomsIndex === segments.length - 1;
}

function inferRoomWorkerUrlFromRequest(
  requestUrl: string,
  fallbackWorkerUrl: string,
  roomId: string,
): string {
  const url = new URL(requestUrl);
  const route = parseRoomRoute(url.pathname);
  if (!route) {
    return buildRoomWorkerUrl(fallbackWorkerUrl, roomId);
  }

  return buildRoomWorkerUrl(`${url.origin}${route.workerBasePath}`, route.roomId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonRecord(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) {
    return {};
  }

  const output: Record<string, JsonValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "number"
      || typeof candidate === "boolean"
      || Array.isArray(candidate)
      || isRecord(candidate)
    ) {
      output[key] = candidate as JsonValue;
    }
  }

  return output;
}

function roleRank(role: MemberRole | null): number {
  switch (role) {
    case "admin":
      return 3;
    case "writer":
      return 2;
    case "reader":
      return 1;
    default:
      return 0;
  }
}

function maxRole(left: MemberRole | null, right: MemberRole | null): MemberRole | null {
  return roleRank(right) > roleRank(left) ? right : left;
}

function parseWorkerUrlRef(workerUrl: string): { id: string; owner: string } {
  const segments = workerUrl.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");
  const id = roomsIndex >= 0 && roomsIndex + 1 < segments.length
    ? decodeURIComponent(segments[roomsIndex + 1])
    : "";
  const hostname = new URL(workerUrl).hostname;
  const owner = hostname.split("-")[0] ?? "";
  return { id, owner };
}

function deepEqualJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }

  if (left === null || right === null) {
    return left === right;
  }

  if (typeof left !== typeof right) {
    return false;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqualJson(left[index] as JsonValue, right[index] as JsonValue)) {
        return false;
      }
    }

    return true;
  }

  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) {
        return false;
      }

      if (!deepEqualJson(left[key] as JsonValue, right[key] as JsonValue)) {
        return false;
      }
    }

    return true;
  }

  return false;
}

type WorkersExec = (url: string, init?: RequestInit) => Promise<Response>;

interface WorkerRequestContext {
  workersExec?: WorkersExec;
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

  async handle(request: Request, ctx: WorkerRequestContext = {}): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_PREFLIGHT_HEADERS,
        });
      }

      const { pathname, searchParams } = new URL(request.url);

      if (request.method === "POST" && isRoomsCollectionPath(pathname)) {
        return await this.createRoom(request);
      }

      const roomRoute = parseRoomRoute(pathname);
      if (!roomRoute) {
        return jsonResponse(404, {
          code: "BAD_REQUEST",
          message: "Endpoint not found",
        });
      }

      if (request.method === "GET" && roomRoute.endpoint === "room") {
        return await this.getRoom(request, roomRoute.roomId, ctx);
      }

      if (request.method === "GET" && roomRoute.endpoint === "messages") {
        const sinceSequence = parseRequiredNonNegativeInteger(
          searchParams.get("sinceSequence"),
          "sinceSequence",
        );
        return await this.getMessages(request, roomRoute.roomId, sinceSequence, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "join") {
        return await this.join(request, roomRoute.roomId);
      }

      if (request.method === "POST" && roomRoute.endpoint === "invite-token") {
        return await this.createInviteToken(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "message") {
        return await this.postMessage(request, roomRoute.roomId, ctx);
      }

      if (request.method === "GET" && roomRoute.endpoint === "is-member") {
        return await this.isMember(request, roomRoute.roomId, ctx);
      }

      if (request.method === "GET" && roomRoute.endpoint === "member-role") {
        return await this.memberRole(request, roomRoute.roomId, ctx);
      }

      if (request.method === "GET" && roomRoute.endpoint === "fields") {
        return await this.getFields(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "fields") {
        return await this.postFields(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "register-child") {
        return await this.registerChild(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "unregister-child") {
        return await this.unregisterChild(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "update-index") {
        return await this.updateIndex(request, roomRoute.roomId, ctx);
      }

      if (request.method === "GET" && roomRoute.endpoint === "db-query") {
        return await this.dbQuery(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "link-parent") {
        return await this.linkParent(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "unlink-parent") {
        return await this.unlinkParent(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "members-add") {
        return await this.membersAdd(request, roomRoute.roomId, ctx);
      }

      if (request.method === "POST" && roomRoute.endpoint === "members-remove") {
        return await this.membersRemove(request, roomRoute.roomId, ctx);
      }

      if (request.method === "GET" && roomRoute.endpoint === "members-direct") {
        return await this.membersDirect(request, roomRoute.roomId, ctx);
      }

      if (request.method === "GET" && roomRoute.endpoint === "members-effective") {
        return await this.membersEffective(request, roomRoute.roomId, ctx);
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

  private async createRoom(request: Request): Promise<Response> {
    const requester = requesterFromHeader(request);
    if (requester !== this.config.owner) {
      error(401, "UNAUTHORIZED", "Only owner can create rooms");
    }

    const body = await parseJson<CreateRoomRequest>(request);
    const roomId = body.roomId?.trim();
    const roomName = body.roomName?.trim();

    if (!roomId || !roomName) {
      error(400, "BAD_REQUEST", "roomId and roomName are required");
    }

    await this.ensureRoomMeta({
      roomId,
      roomName,
      requestUrl: request.url,
    });

    return jsonResponse(200, await this.snapshot(roomId, request.url));
  }

  private async getRoom(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(roomId, requester, ctx);

    const snapshot = await this.snapshot(roomId, request.url);
    return jsonResponse(200, snapshot);
  }

  private async getMessages(
    request: Request,
    roomId: string,
    sinceSequence: number,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(roomId, requester, ctx);

    const currentSequence = await this.getMessageSequence(roomId);
    if (sinceSequence >= currentSequence) {
      return jsonResponse(200, {
        messages: [],
        latestSequence: currentSequence,
      });
    }

    const messageEntries = await this.kv.list(roomGlobalMessagePrefix(roomId));

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

  private async join(request: Request, roomId: string): Promise<Response> {
    const requester = requesterFromHeader(request);
    const body = await parseJson<JoinRequest>(request);
    if (!body.username) {
      error(400, "BAD_REQUEST", "username is required");
    }

    if (body.username !== requester) {
      error(401, "UNAUTHORIZED", "Join username does not match authenticated requester");
    }

    await this.ensureRoomMeta({ roomId, requestUrl: request.url });

    const members = await this.getMembers(roomId);
    const isOwner = body.username === this.config.owner;
    const alreadyMember = members.includes(body.username);

    if (alreadyMember) {
      return jsonResponse(200, await this.snapshot(roomId, request.url));
    }

    if (!isOwner) {
      if (!body.inviteToken) {
        error(401, "INVITE_REQUIRED", "Invite token is required for non-owner first join");
      }

      const invite = await this.kv.get<InviteToken>(tokenKey(roomId, body.inviteToken));
      if (!invite || invite.roomId !== roomId) {
        error(401, "INVITE_REQUIRED", "Invite token is invalid");
      }
    }

    members.push(body.username);
    await this.kv.set(roomMembersKey(roomId), members);

    if (!isOwner) {
      const roles = await this.getMemberRoles(roomId);
      roles[body.username] = roles[body.username] ?? "reader";
      await this.kv.set(roomMemberRolesKey(roomId), roles);
    }

    return jsonResponse(200, await this.snapshot(roomId, request.url));
  }

  private async createInviteToken(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    const payload = await parseJson<InvitePayload>(request);

    await this.assertMember(roomId, requester, ctx);

    if (payload.roomId !== roomId) {
      error(400, "BAD_REQUEST", "Payload roomId does not match route roomId");
    }

    const inviteToken: InviteToken = {
      token: payload.token,
      roomId: payload.roomId,
      invitedBy: requester,
      createdAt: payload.createdAt,
    };

    await this.kv.set(tokenKey(roomId, inviteToken.token), inviteToken);

    return jsonResponse(200, {
      inviteToken,
    });
  }

  private async postMessage(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    const payload = await parseJson<MessagePayload>(request);

    await this.assertMember(roomId, requester, ctx);

    if (payload.roomId !== roomId) {
      error(400, "BAD_REQUEST", "Payload roomId does not match route roomId");
    }

    const sequence = await this.nextMessageSequence(roomId);

    const message: Message = {
      ...payload,
      body: payload.body as Message["body"],
      signedBy: requester,
      sequence,
    };

    await this.kv.set(messageGlobalKey(roomId, message), message);

    return jsonResponse(200, {
      message,
    });
  }

  private async isMember(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    const ttl = parseOptionalNonNegativeInteger(
      new URL(request.url).searchParams.get("ttl"),
      DEFAULT_PARENT_ROOM_TTL,
    );

    await this.assertMember(roomId, requester, ctx, ttl);
    return jsonResponse(200, { isMember: true });
  }

  private async memberRole(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    const ttl = parseOptionalNonNegativeInteger(
      new URL(request.url).searchParams.get("ttl"),
      DEFAULT_PARENT_ROOM_TTL,
    );
    const role = await this.resolveMemberRole(roomId, requester, ctx, ttl);
    if (!role) {
      error(401, "UNAUTHORIZED", "Members only");
    }

    return jsonResponse(200, { role });
  }

  private async getFields(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(roomId, requester, ctx);

    const response: GetFieldsResponse = {
      fields: await this.getRowFields(roomId),
      collection: await this.getRowCollection(roomId),
    };
    return jsonResponse(200, response);
  }

  private async postFields(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertWriterOrAdmin(roomId, requester, ctx);

    const body = await parseJson<PostFieldsRequest>(request);
    const incomingFields = toJsonRecord(body.fields);
    const merge = body.merge ?? true;
    if (!isRecord(body.fields)) {
      error(400, "BAD_REQUEST", "fields must be an object");
    }

    const current = await this.getRowFields(roomId);
    const next = merge
      ? { ...current, ...incomingFields }
      : incomingFields;
    await this.kv.set(rowFieldsKey(roomId), next);

    const currentCollection = await this.getRowCollection(roomId);
    if (body.collection) {
      if (currentCollection && currentCollection !== body.collection) {
        error(400, "BAD_REQUEST", "collection cannot be changed once set");
      }

      await this.kv.set(rowCollectionKey(roomId), body.collection);
    }

    const finalCollection = body.collection ?? currentCollection;
    let indexedParentsUpdated = 0;

    if (finalCollection && ctx.workersExec) {
      const meta = await this.getRoomMeta(roomId, request.url);
      const parentRoomUrls = await this.getParentRoomUrls(roomId);
      const results = await Promise.all(
        parentRoomUrls.map(async (parentWorkerUrl): Promise<boolean> => {
          try {
            const response = await ctx.workersExec!(
              `${stripTrailingSlash(parentWorkerUrl)}/update-index`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-puter-username": this.config.owner,
                },
                body: JSON.stringify({
                  childRowId: roomId,
                  childOwner: this.config.owner,
                  childWorkerUrl: meta.workerUrl,
                  collection: finalCollection,
                  fields: next,
                } satisfies UpdateIndexRequest),
              },
            );
            return response.ok;
          } catch {
            return false;
          }
        }),
      );
      indexedParentsUpdated = results.filter(Boolean).length;
    }

    return jsonResponse(200, {
      fields: next,
      collection: finalCollection,
      indexedParentsUpdated,
    });
  }

  private async registerChild(
    request: Request,
    parentRoomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    const body = await parseJson<RegisterChildRequest>(request);

    if (!body.childRowId || !body.childOwner || !body.childWorkerUrl || !body.collection) {
      error(400, "BAD_REQUEST", "childRowId, childOwner, childWorkerUrl, and collection are required");
    }

    if (requester !== body.childOwner) {
      error(401, "UNAUTHORIZED", "Only child owner can register child");
    }

    await this.assertWriterOrAdmin(parentRoomId, requester, ctx);

    const schema = this.normalizeChildSchema(body.schema);
    if (schema) {
      await this.kv.set(rowChildSchemaKey(parentRoomId, body.collection), schema);
    }

    const childEntry: ChildEntry = {
      rowId: body.childRowId,
      owner: body.childOwner,
      workerUrl: stripTrailingSlash(body.childWorkerUrl),
      collection: body.collection,
      fields: toJsonRecord(body.fields),
      addedAt: this.now(),
      updatedAt: this.now(),
      active: true,
    };

    await this.kv.set(
      rowChildKey(parentRoomId, body.collection, body.childOwner, body.childRowId),
      childEntry,
    );

    const storedSchema = await this.getChildSchema(parentRoomId, body.collection);
    if (storedSchema) {
      await this.writeChildIndexes(parentRoomId, childEntry, storedSchema);
    }

    return jsonResponse(200, {
      ok: true,
      child: childEntry,
    });
  }

  private async unregisterChild(
    request: Request,
    parentRoomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    const body = await parseJson<UnregisterChildRequest>(request);

    if (!body.childRowId || !body.childOwner || !body.collection) {
      error(400, "BAD_REQUEST", "childRowId, childOwner, and collection are required");
    }

    const requesterIsAdmin = await this.hasRole(parentRoomId, requester, ctx, ["admin"]);
    if (!requesterIsAdmin && requester !== body.childOwner) {
      error(401, "UNAUTHORIZED", "Only child owner or parent admin can unregister child");
    }

    const childKey = rowChildKey(parentRoomId, body.collection, body.childOwner, body.childRowId);
    const existing = await this.kv.get<ChildEntry>(childKey);
    if (existing) {
      await this.kv.set(childKey, {
        ...existing,
        active: false,
        updatedAt: this.now(),
      } satisfies ChildEntry);
    }

    await this.tombstoneChildIndexes(parentRoomId, body.collection, body.childOwner, body.childRowId);

    return jsonResponse(200, { ok: true });
  }

  private async updateIndex(
    request: Request,
    parentRoomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    const body = await parseJson<UpdateIndexRequest>(request);

    if (!body.childRowId || !body.childOwner || !body.collection || !isRecord(body.fields)) {
      error(400, "BAD_REQUEST", "childRowId, childOwner, collection, and fields are required");
    }

    if (requester !== body.childOwner) {
      error(401, "UNAUTHORIZED", "Only child owner can update indexes");
    }

    await this.assertMember(parentRoomId, requester, ctx);

    const schema = await this.getChildSchema(parentRoomId, body.collection);
    const childKey = rowChildKey(parentRoomId, body.collection, body.childOwner, body.childRowId);
    const existing = await this.kv.get<ChildEntry>(childKey);
    const nextEntry: ChildEntry = {
      rowId: body.childRowId,
      owner: body.childOwner,
      workerUrl: stripTrailingSlash(body.childWorkerUrl ?? existing?.workerUrl ?? ""),
      collection: body.collection,
      fields: toJsonRecord(body.fields),
      addedAt: existing?.addedAt ?? this.now(),
      updatedAt: this.now(),
      active: true,
    };

    await this.kv.set(childKey, nextEntry);
    await this.tombstoneChildIndexes(parentRoomId, body.collection, body.childOwner, body.childRowId);

    if (!schema) {
      return jsonResponse(200, {
        ok: true,
        updated: false,
      });
    }

    await this.writeChildIndexes(parentRoomId, nextEntry, schema);
    return jsonResponse(200, {
      ok: true,
      updated: true,
    });
  }

  private async dbQuery(
    request: Request,
    parentRoomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(parentRoomId, requester, ctx);

    const url = new URL(request.url);
    const collection = url.searchParams.get("collection")?.trim();
    if (!collection) {
      error(400, "BAD_REQUEST", "collection is required");
    }

    const indexName = url.searchParams.get("index")?.trim() ?? "";
    const order = (url.searchParams.get("order") ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";
    const limit = Math.max(
      1,
      Math.min(MAX_QUERY_LIMIT, parseOptionalNonNegativeInteger(url.searchParams.get("limit"), 50)),
    );

    const whereParam = url.searchParams.get("where");
    const where = whereParam ? toJsonRecord(JSON.parse(whereParam) as unknown) : undefined;

    let rows: ChildEntry[];
    if (indexName) {
      const valueParam = url.searchParams.get("value");
      rows = await this.queryByIndex(parentRoomId, collection, indexName, valueParam, order, limit);
    } else {
      rows = await this.queryByChildren(parentRoomId, collection, where, order, limit);
    }

    return jsonResponse(200, {
      rows: rows.map((row) => ({
        rowId: row.rowId,
        owner: row.owner,
        workerUrl: row.workerUrl,
        collection: row.collection,
        fields: row.fields,
      })),
    });
  }

  private async linkParent(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertWriterOrAdmin(roomId, requester, ctx);
    const body = await parseJson<ParentLinkRequest>(request);

    const parentWorkerUrl = stripTrailingSlash(body.parentWorkerUrl ?? "");
    if (!parentWorkerUrl) {
      error(400, "BAD_REQUEST", "parentWorkerUrl is required");
    }

    const parentRooms = await this.getParentRoomUrls(roomId);
    if (!parentRooms.includes(parentWorkerUrl)) {
      parentRooms.push(parentWorkerUrl);
      await this.kv.set(roomParentRoomsKey(roomId), parentRooms);
    }

    return jsonResponse(200, {
      parentRooms,
    });
  }

  private async unlinkParent(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertWriterOrAdmin(roomId, requester, ctx);
    const body = await parseJson<ParentLinkRequest>(request);

    const parentWorkerUrl = stripTrailingSlash(body.parentWorkerUrl ?? "");
    if (!parentWorkerUrl) {
      error(400, "BAD_REQUEST", "parentWorkerUrl is required");
    }

    const parentRooms = await this.getParentRoomUrls(roomId);
    const next = parentRooms.filter((url) => stripTrailingSlash(url) !== parentWorkerUrl);
    await this.kv.set(roomParentRoomsKey(roomId), next);

    return jsonResponse(200, {
      parentRooms: next,
    });
  }

  private async membersAdd(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertAdmin(roomId, requester, ctx);

    const body = await parseJson<MemberMutationRequest>(request);
    const username = body.username?.trim();
    const role = body.role;
    if (!username || !role || (role !== "admin" && role !== "writer" && role !== "reader")) {
      error(400, "BAD_REQUEST", "username and valid role are required");
    }

    const members = await this.getMembers(roomId);
    if (!members.includes(username)) {
      members.push(username);
      await this.kv.set(roomMembersKey(roomId), members);
    }

    const roles = await this.getMemberRoles(roomId);
    roles[username] = role;
    await this.kv.set(roomMemberRolesKey(roomId), roles);

    return jsonResponse(200, {
      members,
      roles,
    });
  }

  private async membersRemove(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertAdmin(roomId, requester, ctx);

    const body = await parseJson<MemberMutationRequest>(request);
    const username = body.username?.trim();
    if (!username) {
      error(400, "BAD_REQUEST", "username is required");
    }

    const nextMembers = (await this.getMembers(roomId)).filter((member) => member !== username);
    await this.kv.set(roomMembersKey(roomId), nextMembers);

    const roles = await this.getMemberRoles(roomId);
    delete roles[username];
    await this.kv.set(roomMemberRolesKey(roomId), roles);

    return jsonResponse(200, {
      members: nextMembers,
      roles,
    });
  }

  private async membersDirect(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    await this.assertMember(roomId, requester, ctx);

    const members = await this.getMembers(roomId);
    const roles = await this.getMemberRoles(roomId);
    return jsonResponse(200, {
      members: members.map((username) => ({
        username,
        role: username === this.config.owner ? "admin" : roles[username] ?? "reader",
      })),
    });
  }

  private async membersEffective(
    request: Request,
    roomId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const requester = requesterFromHeader(request);
    const ttl = parseOptionalNonNegativeInteger(
      new URL(request.url).searchParams.get("ttl"),
      DEFAULT_PARENT_ROOM_TTL,
    );
    await this.assertMember(roomId, requester, ctx, ttl);

    const members = new Map<string, EffectiveMember>();
    const direct = await this.getMembers(roomId);
    const directRoles = await this.getMemberRoles(roomId);

    for (const username of direct) {
      const role: MemberRole = username === this.config.owner ? "admin" : directRoles[username] ?? "reader";
      const existing = members.get(username);
      if (!existing || roleRank(role) > roleRank(existing.role)) {
        members.set(username, { username, role, via: "direct" });
      }
    }

    if (ttl > 0 && ctx.workersExec) {
      const parentRoomUrls = await this.getParentRoomUrls(roomId);
      await Promise.all(parentRoomUrls.map(async (parentWorkerUrl) => {
        try {
          const response = await ctx.workersExec!(
            `${stripTrailingSlash(parentWorkerUrl)}/members-effective?ttl=${ttl - 1}`,
            {
              method: "GET",
              headers: {
                "x-puter-username": requester,
              },
            },
          );
          if (!response.ok) {
            return;
          }

          const payload = (await response.json()) as { members?: EffectiveMember[] };
          const parentRef = parseWorkerUrlRef(parentWorkerUrl);

          for (const member of payload.members ?? []) {
            const existing = members.get(member.username);
            if (!existing || roleRank(member.role) > roleRank(existing.role)) {
              members.set(member.username, {
                username: member.username,
                role: member.role,
                via: {
                  id: parentRef.id,
                  collection: "unknown",
                  owner: parentRef.owner,
                  workerUrl: stripTrailingSlash(parentWorkerUrl),
                },
              });
            }
          }
        } catch {
          // best effort only
        }
      }));
    }

    return jsonResponse(200, {
      members: Array.from(members.values()),
    });
  }

  private async queryByIndex(
    parentRoomId: string,
    collection: string,
    indexName: string,
    valueParam: string | null,
    order: "asc" | "desc",
    limit: number,
  ): Promise<ChildEntry[]> {
    const prefix = valueParam === null
      ? rowIndexPrefix(parentRoomId, collection, indexName)
      : `${rowIndexPrefix(parentRoomId, collection, indexName)}${valueParam}:`;

    const entries = await this.kv.list(prefix);
    const ordered = order === "asc" ? entries : [...entries].reverse();
    const deduped = new Map<string, ChildEntry>();

    for (const entry of ordered) {
      const value = entry.value as IndexEntry;
      if (!value || value.active === false) {
        continue;
      }

      const child: ChildEntry = {
        rowId: value.rowId,
        owner: value.owner,
        workerUrl: value.workerUrl,
        collection: value.collection,
        fields: value.fields,
        addedAt: value.updatedAt,
        updatedAt: value.updatedAt,
        active: true,
      };

      const dedupeKey = `${child.owner}:${child.rowId}`;
      if (!deduped.has(dedupeKey)) {
        deduped.set(dedupeKey, child);
      }

      if (deduped.size >= limit) {
        break;
      }
    }

    return Array.from(deduped.values()).slice(0, limit);
  }

  private async queryByChildren(
    parentRoomId: string,
    collection: string,
    where: Record<string, JsonValue> | undefined,
    order: "asc" | "desc",
    limit: number,
  ): Promise<ChildEntry[]> {
    const entries = await this.kv.list(rowChildPrefix(parentRoomId, collection));

    const activeChildren = entries
      .map((entry) => entry.value as ChildEntry)
      .filter((entry) => entry && entry.active !== false);

    const filtered = where
      ? activeChildren.filter((child) => Object.entries(where).every(
        ([key, expected]) => deepEqualJson(child.fields[key] as JsonValue, expected),
      ))
      : activeChildren;

    filtered.sort((left, right) => left.updatedAt - right.updatedAt || left.rowId.localeCompare(right.rowId));
    if (order === "desc") {
      filtered.reverse();
    }

    return filtered.slice(0, limit);
  }

  private async writeChildIndexes(
    parentRoomId: string,
    child: ChildEntry,
    schema: ChildCollectionSchema,
  ): Promise<void> {
    const indexes = schema.indexes;
    const fields = child.fields;

    await Promise.all(
      Object.entries(indexes).map(async ([indexName, index]) => {
        const indexValues = index.fields.map((fieldName) => fields[fieldName] ?? null);
        const encoded = encodeCompositeFieldValues(indexValues);
        const indexedFields: Record<string, JsonValue> = {};
        for (const fieldName of index.fields) {
          indexedFields[fieldName] = fields[fieldName] ?? null;
        }

        const key = rowIndexKey(
          parentRoomId,
          child.collection,
          indexName,
          encoded,
          child.owner,
          child.rowId,
        );

        const payload: IndexEntry = {
          rowId: child.rowId,
          owner: child.owner,
          workerUrl: child.workerUrl,
          collection: child.collection,
          fields: indexedFields,
          updatedAt: this.now(),
          active: true,
        };

        await this.kv.set(key, payload);
      }),
    );
  }

  private async tombstoneChildIndexes(
    parentRoomId: string,
    collection: string,
    childOwner: string,
    childRowId: string,
  ): Promise<void> {
    const suffix = `:${childOwner}:${childRowId}`;
    const entries = await this.kv.list(rowIndexCollectionPrefix(parentRoomId, collection));

    await Promise.all(entries.map(async (entry) => {
      if (!entry.key.endsWith(suffix)) {
        return;
      }

      const existing = entry.value as IndexEntry;
      if (!existing || existing.active === false) {
        return;
      }

      await this.kv.set(entry.key, {
        ...existing,
        active: false,
        updatedAt: this.now(),
      } satisfies IndexEntry);
    }));
  }

  private normalizeChildSchema(schema: ChildSchemaPayload | undefined): ChildCollectionSchema | null {
    if (!schema?.indexes || !isRecord(schema.indexes)) {
      return null;
    }

    const normalized: ChildCollectionSchema = {
      indexes: {},
    };

    for (const [name, value] of Object.entries(schema.indexes)) {
      if (!isRecord(value)) {
        continue;
      }

      const fields = Array.isArray(value.fields)
        ? value.fields.filter((field): field is string => typeof field === "string" && field.length > 0)
        : [];
      if (fields.length === 0) {
        continue;
      }

      normalized.indexes[name] = { fields };
    }

    return Object.keys(normalized.indexes).length > 0 ? normalized : null;
  }

  private async getChildSchema(parentRoomId: string, collection: string): Promise<ChildCollectionSchema | null> {
    const stored = await this.kv.get<ChildCollectionSchema>(rowChildSchemaKey(parentRoomId, collection));
    if (!stored || !isRecord(stored.indexes)) {
      return null;
    }

    return stored;
  }

  private async getParentRoomUrls(roomId: string): Promise<string[]> {
    return (await this.kv.get<string[]>(roomParentRoomsKey(roomId))) ?? [];
  }

  private async assertMember(
    roomId: string,
    username: string,
    ctx: WorkerRequestContext,
    ttl: number = DEFAULT_PARENT_ROOM_TTL,
  ): Promise<void> {
    const role = await this.resolveMemberRole(roomId, username, ctx, ttl);
    if (!role) {
      error(401, "UNAUTHORIZED", "Members only");
    }
  }

  private async hasRole(
    roomId: string,
    username: string,
    ctx: WorkerRequestContext,
    roles: MemberRole[],
  ): Promise<boolean> {
    const effectiveRole = await this.resolveMemberRole(roomId, username, ctx);
    return !!effectiveRole && roles.includes(effectiveRole);
  }

  private async assertWriterOrAdmin(
    roomId: string,
    username: string,
    ctx: WorkerRequestContext,
  ): Promise<void> {
    const role = await this.resolveMemberRole(roomId, username, ctx);
    if (role !== "admin" && role !== "writer") {
      error(401, "UNAUTHORIZED", "Writers or admins only");
    }
  }

  private async assertAdmin(roomId: string, username: string, ctx: WorkerRequestContext): Promise<void> {
    const role = await this.resolveMemberRole(roomId, username, ctx);
    if (role !== "admin") {
      error(401, "UNAUTHORIZED", "Admins only");
    }
  }

  private async resolveMemberRole(
    roomId: string,
    username: string,
    ctx: WorkerRequestContext,
    ttl: number = DEFAULT_PARENT_ROOM_TTL,
  ): Promise<MemberRole | null> {
    let bestRole = await this.getDirectRole(roomId, username);

    if (ttl === 0 || !ctx.workersExec) {
      return bestRole;
    }

    const parentRoomUrls = await this.getParentRoomUrls(roomId);
    if (parentRoomUrls.length === 0) {
      return bestRole;
    }

    const parentRoles = await Promise.all(
      parentRoomUrls.map(async (parentUrl): Promise<MemberRole | null> => {
        try {
          const response = await ctx.workersExec!(
            `${stripTrailingSlash(parentUrl)}/member-role?ttl=${ttl - 1}`,
            {
              method: "GET",
              headers: {
                "x-puter-username": username,
              },
            },
          );

          if (!response.ok) {
            return null;
          }

          const payload = (await response.json()) as { role?: MemberRole };
          if (payload.role === "admin" || payload.role === "writer" || payload.role === "reader") {
            return payload.role;
          }

          return null;
        } catch {
          return null;
        }
      }),
    );

    for (const parentRole of parentRoles) {
      bestRole = maxRole(bestRole, parentRole);
    }

    return bestRole;
  }

  private async getDirectRole(roomId: string, username: string): Promise<MemberRole | null> {
    if (username === this.config.owner) {
      return "admin";
    }

    const members = await this.getMembers(roomId);
    if (!members.includes(username)) {
      return null;
    }

    const roles = await this.getMemberRoles(roomId);
    const role = roles[username] ?? "reader";
    return role;
  }

  private async getMembers(roomId: string): Promise<string[]> {
    const stored = await this.kv.get<string[]>(roomMembersKey(roomId));
    return stored ?? [];
  }

  private async getMemberRoles(roomId: string): Promise<Record<string, MemberRole>> {
    const stored = await this.kv.get<Record<string, MemberRole>>(roomMemberRolesKey(roomId));
    return stored ?? {};
  }

  private async getRowFields(roomId: string): Promise<Record<string, JsonValue>> {
    const stored = await this.kv.get<Record<string, JsonValue>>(rowFieldsKey(roomId));
    return stored ?? {};
  }

  private async getRowCollection(roomId: string): Promise<string | null> {
    return await this.kv.get<string>(rowCollectionKey(roomId));
  }

  private async getMessageSequence(roomId: string): Promise<number> {
    const stored = await this.kv.get<number>(roomMessageSequenceKey(roomId));
    if (typeof stored !== "number" || !Number.isFinite(stored) || stored < 0) {
      return 0;
    }

    return Math.floor(stored);
  }

  private async nextMessageSequence(roomId: string): Promise<number> {
    const key = roomMessageSequenceKey(roomId);
    const sequence = await this.kv.incr(key, 1);
    if (!Number.isFinite(sequence) || sequence < 1) {
      error(500, "BAD_REQUEST", "kv.incr returned an invalid sequence");
    }

    return Math.floor(sequence);
  }

  private async getRoomMeta(roomId: string, requestUrl?: string): Promise<Room> {
    await this.ensureRoomMeta({ roomId, requestUrl });
    const room = await this.kv.get<Room>(roomMetaKey(roomId));
    if (!room) {
      error(404, "BAD_REQUEST", `Room ${roomId} does not exist`);
    }

    return room;
  }

  private async ensureRoomMeta(args: {
    roomId: string;
    roomName?: string;
    requestUrl?: string;
  }): Promise<void> {
    const key = roomMetaKey(args.roomId);
    const inferredRoomUrl = args.requestUrl
      ? inferRoomWorkerUrlFromRequest(args.requestUrl, this.config.workerUrl, args.roomId)
      : undefined;
    const existing = await this.kv.get<Room>(key);

    if (existing) {
      if (inferredRoomUrl && existing.workerUrl !== inferredRoomUrl) {
        await this.kv.set(key, {
          ...existing,
          workerUrl: inferredRoomUrl,
        });
      }
      return;
    }

    if (!args.roomName) {
      error(404, "BAD_REQUEST", `Room ${args.roomId} does not exist`);
    }

    const room: Room = {
      id: args.roomId,
      name: args.roomName,
      owner: this.config.owner,
      workerUrl: inferredRoomUrl ?? buildRoomWorkerUrl(this.config.workerUrl, args.roomId),
      createdAt: this.now(),
    };

    await this.kv.set(key, room);
  }

  private async snapshot(roomId: string, requestUrl?: string): Promise<RoomSnapshot> {
    await this.ensureRoomMeta({ roomId, requestUrl });

    const room = await this.kv.get<Room>(roomMetaKey(roomId));
    if (!room) {
      error(400, "BAD_REQUEST", "Room metadata missing");
    }

    const members = await this.getMembers(roomId);
    return {
      ...room,
      members,
      parentRooms: await this.getParentRoomUrls(roomId),
    };
  }
}
