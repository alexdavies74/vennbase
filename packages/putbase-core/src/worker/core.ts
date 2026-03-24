import { encodeCompositeFieldValues } from "../key-encoding";
import { parseProtectedRequest, verifyPrincipalProof, verifyRequestProof } from "../auth";
import { canonicalize } from "../crypto";
import type { WorkersHandler } from "@heyputer/puter.js";
import type { DbFieldValue, MemberRole, RowRef } from "../schema";
import type {
  ApiError,
  InviteToken,
  JsonValue,
  SyncMessage,
  PrincipalProof,
  ProtectedRequest,
  RequestProof,
  Row,
  RowSnapshot,
  VerifiedPrincipal,
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

export interface RowWorkerConfig {
  owner: string;
  ownerPublicKeyJwk?: JsonWebKey;
  workerUrl?: string;
}

interface CreateRowRequest {
  rowId: string;
  rowName: string;
}

interface JoinRequest {
  username: string;
  inviteToken?: string;
}

interface RoleResolutionRequest {
  ttl?: number;
}

interface MessagesRequest {
  sinceSequence: number;
}

type InvitePayload = Pick<InviteToken, "token" | "rowId" | "createdAt" | "invitedBy">;

type SyncMessagePayload = Omit<SyncMessage, "signedBy" | "sequence">;

interface GetFieldsResponse {
  fields: Record<string, JsonValue>;
  collection: string | null;
}

interface PostFieldsRequest {
  fields: Record<string, DbFieldValue>;
  merge?: boolean;
  collection?: string;
}

interface ChildSchemaPayload {
  indexes?: Record<string, { fields?: string[] }>;
}

interface RegisterChildRequest {
  childRef: RowRef;
  childOwner: string;
  collection: string;
  fields?: Record<string, DbFieldValue>;
  schema?: ChildSchemaPayload;
}

interface UnregisterChildRequest {
  childRef: RowRef;
  childOwner: string;
  collection: string;
}

interface UpdateIndexRequest {
  childRef: RowRef;
  childOwner: string;
  collection: string;
  fields: Record<string, DbFieldValue>;
}

interface ParentLinkRequest {
  parentRef: RowRef;
}

interface MemberMutationRequest {
  username: string;
  role?: MemberRole;
}

interface QueryRequest {
  collection: string;
  index?: string;
  value?: string | null;
  order?: "asc" | "desc";
  limit?: number;
  where?: Record<string, DbFieldValue>;
}

interface ChildCollectionSchema {
  indexes: Record<string, { fields: string[] }>;
}

interface ChildEntry {
  rowId: string;
  owner: string;
  baseUrl: string;
  collection: string;
  fields: Record<string, JsonValue>;
  addedAt: number;
  updatedAt: number;
  active: boolean;
}

interface IndexEntry {
  rowId: string;
  owner: string;
  baseUrl: string;
  collection: string;
  fields: Record<string, JsonValue>;
  updatedAt: number;
  active: boolean;
}

interface EffectiveMember {
  username: string;
  role: MemberRole;
  via: "direct" | RowRef;
}

export interface RowWorkerDeps {
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
  "access-control-allow-headers": "content-type,x-puter-no-auth,puter-auth",
};

const CORS_PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-puter-no-auth,puter-auth",
  "access-control-allow-methods": "POST,OPTIONS",
};

const DEFAULT_PARENT_ROW_TTL = 5;
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

function messageGlobalKey(rowId: string, message: Pick<SyncMessage, "createdAt" | "id">): string {
  return `row:${rowId}:global_message:${message.createdAt}:${message.id}`;
}

function tokenKey(rowId: string, token: string): string {
  return `row:${rowId}:invite_token:${token}`;
}

function tokenKeyPrefix(rowId: string): string {
  return `row:${rowId}:invite_token:`;
}

function memberPublicKeyKey(rowId: string, username: string): string {
  return `row:${rowId}:member_public_key:${username}`;
}

function rowMetaKey(rowId: string): string {
  return `row:${rowId}:meta`;
}

function rowMembersKey(rowId: string): string {
  return `row:${rowId}:members`;
}

function rowMemberRolesKey(rowId: string): string {
  return `row:${rowId}:member_roles`;
}

function rowGlobalMessagePrefix(rowId: string): string {
  return `row:${rowId}:global_message:`;
}

function rowMessageSequenceKey(rowId: string): string {
  return `row:${rowId}:global_message_sequence`;
}

function rowParentRefsKey(rowId: string): string {
  return `row:${rowId}:parent_refs`;
}

function rowNonceKey(rowId: string, username: string, nonce: string): string {
  return `row:${rowId}:nonce:${username}:${nonce}`;
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

function buildRowWorkerUrl(workerBaseUrl: string, rowId: string): string {
  return `${stripTrailingSlash(workerBaseUrl)}/rows/${encodeURIComponent(rowId)}`;
}

function rowUrlFromRef(row: Pick<RowRef, "id" | "baseUrl">): string {
  return buildRowWorkerUrl(row.baseUrl, row.id);
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

interface RowRoute {
  rowId: string;
  endpoint: string;
  workerBasePath: string;
}

function parseRowRoute(pathname: string): RowRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  const rowsIndex = segments.indexOf("rows");
  if (rowsIndex < 0 || rowsIndex + 2 >= segments.length) {
    return null;
  }

  return {
    rowId: decodeURIComponent(segments[rowsIndex + 1]),
    endpoint: segments.slice(rowsIndex + 2).join("/"),
    workerBasePath: rowsIndex > 0 ? `/${segments.slice(0, rowsIndex).join("/")}` : "",
  };
}

function isRowsCollectionPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const rowsIndex = segments.indexOf("rows");
  return rowsIndex >= 0 && rowsIndex === segments.length - 1;
}

function inferRowWorkerUrlFromRequest(
  requestUrl: string,
  rowId: string,
  fallbackWorkerUrl?: string,
): string {
  const baseUrl = inferFederationWorkerBaseUrlFromRequest(requestUrl, fallbackWorkerUrl);
  return buildRowWorkerUrl(baseUrl, rowId);
}

function inferFederationWorkerBaseUrlFromRequest(
  requestUrl: string,
  fallbackWorkerUrl?: string,
): string {
  const url = new URL(requestUrl);
  const route = parseRowRoute(url.pathname);
  if (route) {
    return stripTrailingSlash(`${url.origin}${route.workerBasePath}`);
  }

  if (isRowsCollectionPath(url.pathname)) {
    const segments = url.pathname.split("/").filter(Boolean);
    const rowsIndex = segments.indexOf("rows");
    const basePath = rowsIndex > 0 ? `/${segments.slice(0, rowsIndex).join("/")}` : "";
    return stripTrailingSlash(`${url.origin}${basePath}`);
  }

  return stripTrailingSlash(fallbackWorkerUrl ?? url.origin);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFieldRecord(value: unknown, fieldName: string): Record<string, DbFieldValue> {
  if (!isRecord(value)) {
    error(400, "BAD_REQUEST", `${fieldName} must be an object`);
  }

  const output: Record<string, DbFieldValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      typeof candidate === "string"
      || typeof candidate === "number"
      || typeof candidate === "boolean"
    ) {
      output[key] = candidate;
      continue;
    }

    if (isRowRefLike(candidate)) {
      output[key] = normalizeRowRef(candidate, `${fieldName}.${key}`);
      continue;
    }

    error(400, "BAD_REQUEST", `${fieldName}.${key} must be a string, number, boolean, or row ref`);
  }

  return output;
}

function isRowRefLike(value: unknown): value is RowRef {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { collection?: unknown }).collection === "string"
    && typeof (value as { baseUrl?: unknown }).baseUrl === "string";
}

function normalizeRowRef(value: unknown, fieldName: string): RowRef {
  if (!isRecord(value)) {
    error(400, "BAD_REQUEST", `${fieldName} must be an object`);
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const collection = typeof value.collection === "string" ? value.collection.trim() : "";
  const baseUrl = typeof value.baseUrl === "string" ? stripTrailingSlash(value.baseUrl) : "";

  if (!id || !collection || !baseUrl) {
    error(400, "BAD_REQUEST", `${fieldName} must include id, collection, and baseUrl`);
  }

  return {
    id,
    collection,
    baseUrl,
  };
}

function sameRowRef(left: RowRef, right: RowRef): boolean {
  return left.id === right.id
    && left.collection === right.collection
    && stripTrailingSlash(left.baseUrl) === stripTrailingSlash(right.baseUrl);
}

function roleRank(role: MemberRole | null): number {
  switch (role) {
    case "editor":
      return 2;
    case "viewer":
      return 1;
    default:
      return 0;
  }
}

function maxRole(left: MemberRole | null, right: MemberRole | null): MemberRole | null {
  return roleRank(right) > roleRank(left) ? right : left;
}

function normalizeStoredMemberRole(role: unknown): MemberRole | null {
  if (role === "editor") {
    return "editor";
  }

  if (role === "viewer") {
    return "viewer";
  }

  return null;
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

interface WorkerRequestContext {
  workersExec?: WorkersHandler["exec"];
}

export class RowWorker {
  private readonly kv: WorkerKv;

  private readonly now: () => number;

  constructor(
    private readonly config: RowWorkerConfig,
    deps: RowWorkerDeps,
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

      const { pathname } = new URL(request.url);

      if (request.method === "POST" && isRowsCollectionPath(pathname)) {
        return await this.createRow(request);
      }

      const rowRoute = parseRowRoute(pathname);
      if (!rowRoute) {
        return jsonResponse(404, {
          code: "BAD_REQUEST",
          message: "Endpoint not found",
        });
      }

      if (request.method === "POST" && rowRoute.endpoint === "row/get") {
        return await this.getRow(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "sync/poll") {
        return await this.pollSyncMessages(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "row/join") {
        return await this.join(request, rowRoute.rowId);
      }

      if (request.method === "POST" && rowRoute.endpoint === "invite-token/get") {
        return await this.getInviteToken(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "invite-token/create") {
        return await this.createInviteToken(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "sync/send") {
        return await this.sendSyncMessage(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "members/is-member") {
        return await this.isMember(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "members/role") {
        return await this.memberRole(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "fields/get") {
        return await this.getFields(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "fields/set") {
        return await this.postFields(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "parents/register-child") {
        return await this.registerChild(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "parents/unregister-child") {
        return await this.unregisterChild(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "parents/update-index") {
        return await this.updateIndex(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "parents/list") {
        return await this.listParents(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "db/query") {
        return await this.dbQuery(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "parents/link-parent") {
        return await this.linkParent(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "parents/unlink-parent") {
        return await this.unlinkParent(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "members/add") {
        return await this.membersAdd(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "members/remove") {
        return await this.membersRemove(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "members/direct") {
        return await this.membersDirect(request, rowRoute.rowId, ctx);
      }

      if (request.method === "POST" && rowRoute.endpoint === "members/effective") {
        return await this.membersEffective(request, rowRoute.rowId, ctx);
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

  private async requireProtectedPayload<TPayload>(
    request: Request,
    args: {
      action: string;
      rowId: string;
      requireRequestProof?: boolean;
      verifyBinding?: boolean;
    },
  ): Promise<{ payload: TPayload; principal: VerifiedPrincipal; auth: ProtectedRequest<TPayload>["auth"] }> {
    let protectedRequest: ProtectedRequest<TPayload>;
    try {
      protectedRequest = await parseProtectedRequest<TPayload>(request);
    } catch (err) {
      error(400, "BAD_REQUEST", err instanceof Error ? err.message : "Invalid protected request");
    }

    let principal: VerifiedPrincipal;
    try {
      principal = await verifyPrincipalProof(protectedRequest.auth.principal);
      if (args.requireRequestProof !== false) {
        await verifyRequestProof({
          proof: protectedRequest.auth.request,
          action: args.action,
          rowId: args.rowId,
          payload: protectedRequest.payload,
          principal: protectedRequest.auth.principal,
          publicKey: principal.publicKey,
        });
        await this.assertFreshNonce(args.rowId, principal.username, protectedRequest.auth.request!.nonce);
      }
    } catch (err) {
      error(401, "INVALID_SIGNATURE", err instanceof Error ? err.message : "Invalid auth proof");
    }

    if (args.verifyBinding === true) {
      await this.assertPrincipalBound(args.rowId, principal);
    }

    return {
      payload: protectedRequest.payload,
      principal,
      auth: protectedRequest.auth,
    };
  }

  private async assertFreshNonce(rowId: string, username: string, nonce: string): Promise<void> {
    const key = rowNonceKey(rowId, username, nonce);
    const existing = await this.kv.get<number>(key);
    if (typeof existing === "number") {
      error(401, "UNAUTHORIZED", "Request proof nonce has already been used");
    }

    await this.kv.set(key, this.now());
  }

  private async assertPrincipalBound(rowId: string, principal: VerifiedPrincipal): Promise<void> {
    if (principal.username === this.config.owner) {
      if (this.config.ownerPublicKeyJwk && canonicalize(principal.publicKeyJwk) !== canonicalize(this.config.ownerPublicKeyJwk)) {
        error(401, "KEY_MISMATCH", "Owner key does not match worker configuration");
      }
      return;
    }

    const members = await this.getMembers(rowId);
    if (!members.includes(principal.username)) {
      error(401, "UNAUTHORIZED", "Members only");
    }

    const existing = await this.kv.get<JsonWebKey>(memberPublicKeyKey(rowId, principal.username));
    if (!existing) {
      error(401, "UNAUTHORIZED", "Member key missing");
    }

    if (canonicalize(existing) !== canonicalize(principal.publicKeyJwk)) {
      error(401, "KEY_MISMATCH", "Public key does not match bound member key");
    }
  }

  private async createRow(request: Request): Promise<Response> {
    let protectedRequest: ProtectedRequest<CreateRowRequest>;
    try {
      protectedRequest = await parseProtectedRequest<CreateRowRequest>(request);
    } catch (err) {
      error(400, "BAD_REQUEST", err instanceof Error ? err.message : "Invalid protected request");
    }

    const body = protectedRequest.payload;
    const rowId = body.rowId?.trim();
    const rowName = body.rowName?.trim();

    if (!rowId || !rowName) {
      error(400, "BAD_REQUEST", "rowId and rowName are required");
    }

    let principal: VerifiedPrincipal;
    try {
      principal = await verifyPrincipalProof(protectedRequest.auth.principal);
      await verifyRequestProof({
        proof: protectedRequest.auth.request,
        action: "rows/create",
        rowId,
        payload: body,
        principal: protectedRequest.auth.principal,
        publicKey: principal.publicKey,
      });
      await this.assertFreshNonce(rowId, principal.username, protectedRequest.auth.request!.nonce);
    } catch (err) {
      error(401, "INVALID_SIGNATURE", err instanceof Error ? err.message : "Invalid auth proof");
    }
    if (principal.username !== this.config.owner) {
      error(401, "UNAUTHORIZED", "Only owner can create rows");
    }
    if (this.config.ownerPublicKeyJwk && canonicalize(principal.publicKeyJwk) !== canonicalize(this.config.ownerPublicKeyJwk)) {
      error(401, "KEY_MISMATCH", "Owner key does not match worker configuration");
    }

    await this.ensureRowMeta({
      rowId,
      rowName,
      requestUrl: request.url,
    });

    return jsonResponse(200, await this.snapshot(rowId, request.url));
  }

  private async getRow(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { principal } = await this.requireProtectedPayload<Record<string, never>>(request, {
      action: "row/get",
      rowId,
    });
    await this.assertMember(rowId, principal, ctx);

    const snapshot = await this.snapshot(rowId, request.url);
    return jsonResponse(200, snapshot);
  }

  private async pollSyncMessages(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { principal, payload } = await this.requireProtectedPayload<MessagesRequest>(request, {
      action: "sync/poll",
      rowId,
    });
    if (payload.sinceSequence == null) {
      error(400, "BAD_REQUEST", "sinceSequence is required");
    }
    const sinceSequence = parseOptionalNonNegativeInteger(String(payload.sinceSequence), 0);
    await this.assertMember(rowId, principal, ctx);

    const currentSequence = await this.getMessageSequence(rowId);
    if (sinceSequence >= currentSequence) {
      return jsonResponse(200, {
        messages: [],
        latestSequence: currentSequence,
      });
    }

    const messageEntries = await this.kv.list(rowGlobalMessagePrefix(rowId));

    const messages = messageEntries
      .map((entry) => entry.value as SyncMessage)
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

  private async join(request: Request, rowId: string): Promise<Response> {
    const { payload: body, principal } = await this.requireProtectedPayload<JoinRequest>(request, {
      action: "row/join",
      rowId,
      verifyBinding: false,
    });
    if (!body.username) {
      error(400, "BAD_REQUEST", "username is required");
    }

    if (body.username !== principal.username) {
      error(401, "UNAUTHORIZED", "Join username does not match principal proof");
    }

    await this.ensureRowMeta({ rowId, requestUrl: request.url });

    const members = await this.getMembers(rowId);
    const isOwner = body.username === this.config.owner;
    const alreadyMember = members.includes(body.username);

    if (alreadyMember) {
      const existingKey = await this.kv.get<JsonWebKey>(memberPublicKeyKey(rowId, body.username));
      if (!existingKey) {
        await this.kv.set(memberPublicKeyKey(rowId, body.username), principal.publicKeyJwk);
      } else if (canonicalize(existingKey) !== canonicalize(principal.publicKeyJwk)) {
        error(401, "KEY_MISMATCH", "Public key does not match bound member key");
      }
      return jsonResponse(200, await this.snapshot(rowId, request.url));
    }

    if (!isOwner) {
      if (!body.inviteToken) {
        error(401, "INVITE_REQUIRED", "Invite token is required for non-owner first join");
      }

      const invite = await this.kv.get<InviteToken>(tokenKey(rowId, body.inviteToken));
      if (!invite || invite.rowId !== rowId) {
        error(401, "INVITE_REQUIRED", "Invite token is invalid");
      }
    }

    members.push(body.username);
    await this.kv.set(rowMembersKey(rowId), members);
    await this.kv.set(memberPublicKeyKey(rowId, body.username), principal.publicKeyJwk);

    if (!isOwner) {
      const roles = await this.getMemberRoles(rowId);
      roles[body.username] = roles[body.username] ?? "editor";
      await this.kv.set(rowMemberRolesKey(rowId), roles);
    }

    return jsonResponse(200, await this.snapshot(rowId, request.url));
  }

  private async getInviteToken(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { principal } = await this.requireProtectedPayload<Record<string, never>>(request, {
      action: "invite-token/get",
      rowId,
    });
    await this.assertMember(rowId, principal, ctx);

    const entries = await this.kv.list(tokenKeyPrefix(rowId));
    const existing = entries
      .map((e) => e.value as InviteToken)
      .find((t) => t.invitedBy === principal.username && t.rowId === rowId);

    return jsonResponse(200, { inviteToken: existing ?? null });
  }

  private async createInviteToken(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload, principal } = await this.requireProtectedPayload<InvitePayload>(request, {
      action: "invite-token/create",
      rowId,
    });
    await this.assertMember(rowId, principal, ctx);

    if (payload.rowId !== rowId) {
      error(400, "BAD_REQUEST", "Payload rowId does not match route rowId");
    }

    const inviteToken: InviteToken = {
      token: payload.token,
      rowId: payload.rowId,
      invitedBy: principal.username,
      createdAt: payload.createdAt,
    };

    await this.kv.set(tokenKey(rowId, inviteToken.token), inviteToken);

    return jsonResponse(200, {
      inviteToken,
    });
  }

  private async sendSyncMessage(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload, principal } = await this.requireProtectedPayload<SyncMessagePayload>(request, {
      action: "sync/send",
      rowId,
    });
    await this.assertWriter(rowId, principal, ctx);

    if (payload.rowId !== rowId) {
      error(400, "BAD_REQUEST", "Payload rowId does not match route rowId");
    }

    const sequence = await this.nextMessageSequence(rowId);

    const message: SyncMessage = {
      ...payload,
      body: payload.body as SyncMessage["body"],
      signedBy: principal.username,
      sequence,
    };

    await this.kv.set(messageGlobalKey(rowId, message), message);

    return jsonResponse(200, {
      message,
    });
  }

  private async isMember(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload, principal } = await this.requireProtectedPayload<RoleResolutionRequest>(request, {
      action: "members/is-member",
      rowId,
    });
    const ttl = parseOptionalNonNegativeInteger(payload.ttl == null ? null : String(payload.ttl), DEFAULT_PARENT_ROW_TTL);
    await this.assertMember(rowId, principal, ctx, ttl);
    return jsonResponse(200, { isMember: true });
  }

  private async memberRole(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload, principal } = await this.requireProtectedPayload<RoleResolutionRequest>(request, {
      action: "members/role",
      rowId,
      requireRequestProof: false,
    });
    const ttl = parseOptionalNonNegativeInteger(payload.ttl == null ? null : String(payload.ttl), DEFAULT_PARENT_ROW_TTL);
    const role = await this.resolveMemberRole(rowId, principal, ctx, ttl);
    if (!role) {
      error(401, "UNAUTHORIZED", "Members only");
    }

    return jsonResponse(200, { role });
  }

  private async getFields(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { principal } = await this.requireProtectedPayload<Record<string, never>>(request, {
      action: "fields/get",
      rowId,
    });
    await this.assertMember(rowId, principal, ctx);

    const response: GetFieldsResponse = {
      fields: await this.getRowFields(rowId),
      collection: await this.getRowCollection(rowId),
    };
    return jsonResponse(200, response);
  }

  private async postFields(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload: body, principal } = await this.requireProtectedPayload<PostFieldsRequest>(request, {
      action: "fields/set",
      rowId,
    });
    await this.assertWriter(rowId, principal, ctx);
    const incomingFields = toFieldRecord(body.fields, "fields");
    const merge = body.merge ?? true;

    const current = await this.getRowFields(rowId);
    const next = merge
      ? { ...current, ...incomingFields }
      : incomingFields;
    await this.kv.set(rowFieldsKey(rowId), next);

    const currentCollection = await this.getRowCollection(rowId);
    if (body.collection) {
      if (currentCollection && currentCollection !== body.collection) {
        error(400, "BAD_REQUEST", "collection cannot be changed once set");
      }

      await this.kv.set(rowCollectionKey(rowId), body.collection);
    }

    const finalCollection = body.collection ?? currentCollection;
    return jsonResponse(200, {
      fields: next,
      collection: finalCollection,
      indexedParentsUpdated: 0,
    });
  }

  private async registerChild(
    request: Request,
    parentRowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload: body, principal, auth } = await this.requireProtectedPayload<RegisterChildRequest>(request, {
      action: "parents/register-child",
      rowId: parentRowId,
    });

    const childRef = normalizeRowRef(body.childRef, "childRef");
    const parentBaseUrl = inferFederationWorkerBaseUrlFromRequest(request.url, this.config.workerUrl);

    if (!body.childOwner || !body.collection) {
      error(400, "BAD_REQUEST", "childRef, childOwner, and collection are required");
    }

    await this.assertCanMaintainParentIndex({
      auth,
      childOwner: body.childOwner,
      childRef,
      ctx,
      parentRowId,
      parentBaseUrl,
      principal,
    });

    const schema = this.normalizeChildSchema(body.schema);
    if (schema) {
      await this.kv.set(rowChildSchemaKey(parentRowId, body.collection), schema);
    }

    const childEntry: ChildEntry = {
      rowId: childRef.id,
      owner: body.childOwner,
      baseUrl: childRef.baseUrl,
      collection: body.collection,
      fields: body.fields ? toFieldRecord(body.fields, "fields") : {},
      addedAt: this.now(),
      updatedAt: this.now(),
      active: true,
    };

    await this.kv.set(
      rowChildKey(parentRowId, body.collection, body.childOwner, childRef.id),
      childEntry,
    );

    const storedSchema = await this.getChildSchema(parentRowId, body.collection);
    if (storedSchema) {
      await this.writeChildIndexes(parentRowId, childEntry, storedSchema);
    }

    return jsonResponse(200, {
      ok: true,
      child: childEntry,
    });
  }

  private async unregisterChild(
    request: Request,
    parentRowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload: body, principal } = await this.requireProtectedPayload<UnregisterChildRequest>(request, {
      action: "parents/unregister-child",
      rowId: parentRowId,
    });

    const childRef = normalizeRowRef(body.childRef, "childRef");
    if (!body.childOwner || !body.collection) {
      error(400, "BAD_REQUEST", "childRef, childOwner, and collection are required");
    }

    const requesterCanManageParent = await this.hasRole(parentRowId, principal, ctx, ["editor"]);
    if (!requesterCanManageParent && principal.username !== body.childOwner) {
      error(401, "UNAUTHORIZED", "Only child owner or parent editor can unregister child");
    }

    const childKey = rowChildKey(parentRowId, body.collection, body.childOwner, childRef.id);
    const existing = await this.kv.get<ChildEntry>(childKey);
    if (existing) {
      await this.kv.set(childKey, {
        ...existing,
        active: false,
        updatedAt: this.now(),
      } satisfies ChildEntry);
    }

    await this.tombstoneChildIndexes(parentRowId, body.collection, body.childOwner, childRef.id);

    return jsonResponse(200, { ok: true });
  }

  private async updateIndex(
    request: Request,
    parentRowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload: body, principal, auth } = await this.requireProtectedPayload<UpdateIndexRequest>(request, {
      action: "parents/update-index",
      rowId: parentRowId,
      requireRequestProof: false,
    });

    const childRef = normalizeRowRef(body.childRef, "childRef");
    if (!body.childOwner || !body.collection) {
      error(400, "BAD_REQUEST", "childRef, childOwner, collection, and fields are required");
    }

    const parentBaseUrl = inferFederationWorkerBaseUrlFromRequest(request.url, this.config.workerUrl);
    await this.assertCanMaintainParentIndex({
      auth,
      childOwner: body.childOwner,
      childRef,
      ctx,
      parentRowId,
      parentBaseUrl,
      principal,
    });

    const schema = await this.getChildSchema(parentRowId, body.collection);
    const childKey = rowChildKey(parentRowId, body.collection, body.childOwner, childRef.id);
    const existing = await this.kv.get<ChildEntry>(childKey);
    const nextEntry: ChildEntry = {
      rowId: childRef.id,
      owner: body.childOwner,
      baseUrl: childRef.baseUrl || stripTrailingSlash(existing?.baseUrl ?? ""),
      collection: body.collection,
      fields: toFieldRecord(body.fields, "fields"),
      addedAt: existing?.addedAt ?? this.now(),
      updatedAt: this.now(),
      active: true,
    };

    await this.kv.set(childKey, nextEntry);
    await this.tombstoneChildIndexes(parentRowId, body.collection, body.childOwner, childRef.id);

    if (!schema) {
      return jsonResponse(200, {
        ok: true,
        updated: false,
      });
    }

    await this.writeChildIndexes(parentRowId, nextEntry, schema);
    return jsonResponse(200, {
      ok: true,
      updated: true,
    });
  }

  private async listParents(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { principal } = await this.requireProtectedPayload<Record<string, never>>(request, {
      action: "parents/list",
      rowId,
      requireRequestProof: false,
    });
    await this.assertMember(rowId, principal, ctx);

    return jsonResponse(200, {
      parentRefs: await this.getParentRefs(rowId),
    });
  }

  private async dbQuery(
    request: Request,
    parentRowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload, principal } = await this.requireProtectedPayload<QueryRequest>(request, {
      action: "db/query",
      rowId: parentRowId,
    });
    await this.assertMember(parentRowId, principal, ctx);

    const collection = payload.collection?.trim();
    if (!collection) {
      error(400, "BAD_REQUEST", "collection is required");
    }

    const indexName = payload.index?.trim() ?? "";
    const order = (payload.order ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";
    const limit = Math.max(
      1,
      Math.min(MAX_QUERY_LIMIT, parseOptionalNonNegativeInteger(payload.limit == null ? null : String(payload.limit), 50)),
    );
    const where = payload.where ? toFieldRecord(payload.where, "where") : undefined;

    let rows: ChildEntry[];
    if (indexName) {
      rows = await this.queryByIndex(parentRowId, collection, indexName, payload.value ?? null, order, limit);
    } else {
      rows = await this.queryByChildren(parentRowId, collection, where, order, limit);
    }

    return jsonResponse(200, {
      rows: rows.map((row) => ({
        rowId: row.rowId,
        owner: row.owner,
        baseUrl: row.baseUrl,
        collection: row.collection,
        fields: row.fields,
      })),
    });
  }

  private async linkParent(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload: body, principal } = await this.requireProtectedPayload<ParentLinkRequest>(request, {
      action: "parents/link-parent",
      rowId,
    });
    await this.assertWriter(rowId, principal, ctx);

    const parentRef = normalizeRowRef(body.parentRef, "parentRef");

    const parentRefs = await this.getParentRefs(rowId);
    if (!parentRefs.some((existing) => sameRowRef(existing, parentRef))) {
      parentRefs.push(parentRef);
      await this.kv.set(rowParentRefsKey(rowId), parentRefs);
    }

    return jsonResponse(200, {
      parentRefs,
    });
  }

  private async unlinkParent(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload: body, principal } = await this.requireProtectedPayload<ParentLinkRequest>(request, {
      action: "parents/unlink-parent",
      rowId,
    });
    await this.assertWriter(rowId, principal, ctx);

    const parentRef = normalizeRowRef(body.parentRef, "parentRef");

    const parentRefs = await this.getParentRefs(rowId);
    const next = parentRefs.filter((existing) => !sameRowRef(existing, parentRef));
    await this.kv.set(rowParentRefsKey(rowId), next);

    return jsonResponse(200, {
      parentRefs: next,
    });
  }

  private async membersAdd(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload: body, principal } = await this.requireProtectedPayload<MemberMutationRequest>(request, {
      action: "members/add",
      rowId,
    });
    await this.assertWriter(rowId, principal, ctx);
    const username = body.username?.trim();
    const role = body.role;
    if (!username || !role || (role !== "editor" && role !== "viewer")) {
      error(400, "BAD_REQUEST", "username and valid role are required");
    }

    const members = await this.getMembers(rowId);
    if (!members.includes(username)) {
      members.push(username);
      await this.kv.set(rowMembersKey(rowId), members);
    }

    const roles = await this.getMemberRoles(rowId);
    roles[username] = role;
    await this.kv.set(rowMemberRolesKey(rowId), roles);

    return jsonResponse(200, {
      members,
      roles,
    });
  }

  private async membersRemove(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload: body, principal } = await this.requireProtectedPayload<MemberMutationRequest>(request, {
      action: "members/remove",
      rowId,
    });
    await this.assertWriter(rowId, principal, ctx);
    const username = body.username?.trim();
    if (!username) {
      error(400, "BAD_REQUEST", "username is required");
    }

    const nextMembers = (await this.getMembers(rowId)).filter((member) => member !== username);
    await this.kv.set(rowMembersKey(rowId), nextMembers);

    const roles = await this.getMemberRoles(rowId);
    delete roles[username];
    await this.kv.set(rowMemberRolesKey(rowId), roles);
    if (typeof this.kv.delete === "function") {
      await this.kv.delete(memberPublicKeyKey(rowId, username));
    }

    return jsonResponse(200, {
      members: nextMembers,
      roles,
    });
  }

  private async membersDirect(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { principal } = await this.requireProtectedPayload<Record<string, never>>(request, {
      action: "members/direct",
      rowId,
    });
    await this.assertMember(rowId, principal, ctx);

    const members = await this.getMembers(rowId);
    const roles = await this.getMemberRoles(rowId);
    return jsonResponse(200, {
      members: members.map((username) => ({
        username,
        role: username === this.config.owner ? "editor" : roles[username] ?? "viewer",
      })),
    });
  }

  private async membersEffective(
    request: Request,
    rowId: string,
    ctx: WorkerRequestContext,
  ): Promise<Response> {
    const { payload, principal, auth } = await this.requireProtectedPayload<RoleResolutionRequest>(request, {
      action: "members/effective",
      rowId,
      requireRequestProof: false,
    });
    const ttl = parseOptionalNonNegativeInteger(payload.ttl == null ? null : String(payload.ttl), DEFAULT_PARENT_ROW_TTL);
    await this.assertMember(rowId, principal, ctx, ttl);

    const members = new Map<string, EffectiveMember>();
    const direct = await this.getMembers(rowId);
    const directRoles = await this.getMemberRoles(rowId);

    for (const username of direct) {
      const role: MemberRole = username === this.config.owner ? "editor" : directRoles[username] ?? "viewer";
      const existing = members.get(username);
      if (!existing || roleRank(role) > roleRank(existing.role)) {
        members.set(username, { username, role, via: "direct" });
      }
    }

    if (ttl > 0 && ctx.workersExec) {
      const parentRefs = await this.getParentRefs(rowId);
      await Promise.all(parentRefs.map(async (parentRef) => {
        try {
          const forwarded: ProtectedRequest<RoleResolutionRequest> = {
            auth: {
              principal: auth.principal,
            },
            payload: {
              ttl: ttl - 1,
            },
          };
          const response = await ctx.workersExec!(
            `${rowUrlFromRef(parentRef)}/members/effective`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-puter-no-auth": "1",
              },
              body: JSON.stringify(forwarded),
            },
          );
          const payload = await response.json().catch(() => null) as { members?: EffectiveMember[] } | null;
          if (!response.ok) {
            return;
          }

          for (const member of payload?.members ?? []) {
            const existing = members.get(member.username);
            if (!existing || roleRank(member.role) > roleRank(existing.role)) {
              members.set(member.username, {
                username: member.username,
                role: member.role,
                via: parentRef,
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

  private async assertCanMaintainParentIndex(args: {
    auth: ProtectedRequest<unknown>["auth"];
    childOwner: string;
    childRef: RowRef;
    ctx: WorkerRequestContext;
    parentRowId: string;
    parentBaseUrl: string;
    principal: VerifiedPrincipal;
  }): Promise<void> {
    const isParentMember = await this.hasRole(args.parentRowId, args.principal, args.ctx, ["editor", "viewer"]);
    const canWriteChild = await this.canWriteChildRow(args);

    if (isParentMember && canWriteChild) {
      return;
    }

    if (
      canWriteChild
      && await this.remoteRowHasParent(args.childRef, {
        id: args.parentRowId,
        baseUrl: args.parentBaseUrl,
      }, args.auth.principal, args.ctx)
    ) {
      return;
    }

    error(401, "UNAUTHORIZED", "Must be a parent member or a editor on a linked child row");
  }

  private async canWriteChildRow(args: {
    auth: ProtectedRequest<unknown>["auth"];
    childOwner: string;
    childRef: RowRef;
    ctx: WorkerRequestContext;
    principal: VerifiedPrincipal;
  }): Promise<boolean> {
    if (args.principal.username === args.childOwner) {
      return true;
    }

    const role = await this.resolveRemoteRowRole(args.childRef, args.auth.principal, args.ctx, 1);
    return role === "editor";
  }

  private async resolveRemoteRowRole(
    rowRef: RowRef,
    principal: PrincipalProof,
    ctx: WorkerRequestContext,
    ttl: number,
  ): Promise<MemberRole | null> {
    if (!ctx.workersExec) {
      return null;
    }

    try {
      const forwarded: ProtectedRequest<RoleResolutionRequest> = {
        auth: {
          principal,
        },
        payload: {
          ttl,
        },
      };
      const response = await ctx.workersExec(
        `${rowUrlFromRef(rowRef)}/members/role`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-puter-no-auth": "1",
          },
          body: JSON.stringify(forwarded),
        },
      );
      const payload = await response.json().catch(() => null) as { role?: MemberRole } | null;
      if (!response.ok) {
        return null;
      }

      const role = normalizeStoredMemberRole(payload?.role);
      if (role) {
        return role;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async remoteRowHasParent(
    rowRef: RowRef,
    parentRef: Pick<RowRef, "id" | "baseUrl">,
    principal: PrincipalProof,
    ctx: WorkerRequestContext,
  ): Promise<boolean> {
    if (!ctx.workersExec) {
      return false;
    }

    try {
      const forwarded: ProtectedRequest<Record<string, never>> = {
        auth: {
          principal,
        },
        payload: {},
      };
      const response = await ctx.workersExec(
        `${rowUrlFromRef(rowRef)}/parents/list`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-puter-no-auth": "1",
          },
          body: JSON.stringify(forwarded),
        },
      );
      const payload = await response.json().catch(() => null) as { parentRefs?: Array<{ id?: string; baseUrl?: string }> } | null;
      if (!response.ok) {
        return false;
      }

      return (payload?.parentRefs ?? []).some((candidate) =>
        candidate.id === parentRef.id && stripTrailingSlash(candidate.baseUrl ?? "") === stripTrailingSlash(parentRef.baseUrl),
      );
    } catch {
      return false;
    }
  }

  private async queryByIndex(
    parentRowId: string,
    collection: string,
    indexName: string,
    valueParam: string | null,
    order: "asc" | "desc",
    limit: number,
  ): Promise<ChildEntry[]> {
    const prefix = valueParam === null
      ? rowIndexPrefix(parentRowId, collection, indexName)
      : `${rowIndexPrefix(parentRowId, collection, indexName)}${valueParam}:`;

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
        baseUrl: value.baseUrl,
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
    parentRowId: string,
    collection: string,
    where: Record<string, JsonValue> | undefined,
    order: "asc" | "desc",
    limit: number,
  ): Promise<ChildEntry[]> {
    const entries = await this.kv.list(rowChildPrefix(parentRowId, collection));

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
    parentRowId: string,
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
          parentRowId,
          child.collection,
          indexName,
          encoded,
          child.owner,
          child.rowId,
        );

        const payload: IndexEntry = {
          rowId: child.rowId,
          owner: child.owner,
          baseUrl: child.baseUrl,
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
    parentRowId: string,
    collection: string,
    childOwner: string,
    childRowId: string,
  ): Promise<void> {
    const suffix = `:${childOwner}:${childRowId}`;
    const entries = await this.kv.list(rowIndexCollectionPrefix(parentRowId, collection));

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

  private async getChildSchema(parentRowId: string, collection: string): Promise<ChildCollectionSchema | null> {
    const stored = await this.kv.get<ChildCollectionSchema>(rowChildSchemaKey(parentRowId, collection));
    if (!stored || !isRecord(stored.indexes)) {
      return null;
    }

    return stored;
  }

  private async getParentRefs(rowId: string): Promise<RowRef[]> {
    return (await this.kv.get<RowRef[]>(rowParentRefsKey(rowId))) ?? [];
  }

  private async assertMember(
    rowId: string,
    principal: VerifiedPrincipal,
    ctx: WorkerRequestContext,
    ttl: number = DEFAULT_PARENT_ROW_TTL,
  ): Promise<void> {
    const role = await this.resolveMemberRole(rowId, principal, ctx, ttl);
    if (!role) {
      error(401, "UNAUTHORIZED", "Members only");
    }
  }

  private async hasRole(
    rowId: string,
    principal: VerifiedPrincipal,
    ctx: WorkerRequestContext,
    roles: MemberRole[],
  ): Promise<boolean> {
    const effectiveRole = await this.resolveMemberRole(rowId, principal, ctx);
    return !!effectiveRole && roles.includes(effectiveRole);
  }

  private async assertWriter(
    rowId: string,
    principal: VerifiedPrincipal,
    ctx: WorkerRequestContext,
  ): Promise<void> {
    const role = await this.resolveMemberRole(rowId, principal, ctx);
    if (role !== "editor") {
      error(401, "UNAUTHORIZED", "Writers only");
    }
  }

  private async resolveMemberRole(
    rowId: string,
    principal: VerifiedPrincipal,
    ctx: WorkerRequestContext,
    ttl: number = DEFAULT_PARENT_ROW_TTL,
  ): Promise<MemberRole | null> {
    let bestRole = await this.getDirectRole(rowId, principal);

    if (ttl === 0 || !ctx.workersExec) {
      return bestRole;
    }

    const parentRefs = await this.getParentRefs(rowId);
    if (parentRefs.length === 0) {
      return bestRole;
    }

    const parentRoles = await Promise.all(
      parentRefs.map(async (parentRef): Promise<MemberRole | null> => {
        try {
          const forwarded: ProtectedRequest<RoleResolutionRequest> = {
            auth: {
              principal: principal.proof,
            },
            payload: {
              ttl: ttl - 1,
            },
          };
          const response = await ctx.workersExec!(
            `${rowUrlFromRef(parentRef)}/members/role`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-puter-no-auth": "1",
              },
              body: JSON.stringify(forwarded),
            },
          );
          const payload = await response.json().catch(() => null) as { role?: MemberRole } | null;

          if (!response.ok) {
            return null;
          }

          const role = normalizeStoredMemberRole(payload?.role);
          if (role) {
            return role;
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

  private async getDirectRole(rowId: string, principal: VerifiedPrincipal): Promise<MemberRole | null> {
    if (principal.username === this.config.owner) {
      if (this.config.ownerPublicKeyJwk && canonicalize(principal.publicKeyJwk) !== canonicalize(this.config.ownerPublicKeyJwk)) {
        return null;
      }
      return "editor";
    }

    const members = await this.getMembers(rowId);
    if (!members.includes(principal.username)) {
      return null;
    }
    const storedKey = await this.kv.get<JsonWebKey>(memberPublicKeyKey(rowId, principal.username));
    if (!storedKey) {
      await this.kv.set(memberPublicKeyKey(rowId, principal.username), principal.publicKeyJwk);
    } else if (canonicalize(storedKey) !== canonicalize(principal.publicKeyJwk)) {
      return null;
    }

    const roles = await this.getMemberRoles(rowId);
    const role = roles[principal.username] ?? "viewer";
    return role;
  }

  private async getMembers(rowId: string): Promise<string[]> {
    const stored = await this.kv.get<string[]>(rowMembersKey(rowId));
    return stored ?? [];
  }

  private async getMemberRoles(rowId: string): Promise<Record<string, MemberRole>> {
    const stored = await this.kv.get<Record<string, unknown>>(rowMemberRolesKey(rowId));
    if (!stored || typeof stored !== "object") {
      return {};
    }

    const normalized: Record<string, MemberRole> = {};

    for (const [username, role] of Object.entries(stored)) {
      const normalizedRole = normalizeStoredMemberRole(role);
      if (!normalizedRole) {
        continue;
      }

      normalized[username] = normalizedRole;
    }

    return normalized;
  }

  private async getRowFields(rowId: string): Promise<Record<string, JsonValue>> {
    const stored = await this.kv.get<Record<string, JsonValue>>(rowFieldsKey(rowId));
    return stored ?? {};
  }

  private async getRowCollection(rowId: string): Promise<string | null> {
    return await this.kv.get<string>(rowCollectionKey(rowId));
  }

  private async getMessageSequence(rowId: string): Promise<number> {
    const stored = await this.kv.get<number>(rowMessageSequenceKey(rowId));
    if (typeof stored !== "number" || !Number.isFinite(stored) || stored < 0) {
      return 0;
    }

    return Math.floor(stored);
  }

  private async nextMessageSequence(rowId: string): Promise<number> {
    const key = rowMessageSequenceKey(rowId);
    const sequence = await this.kv.incr(key, 1);
    if (!Number.isFinite(sequence) || sequence < 1) {
      error(500, "BAD_REQUEST", "kv.incr returned an invalid sequence");
    }

    return Math.floor(sequence);
  }

  private async getRowMeta(rowId: string, requestUrl?: string): Promise<Row> {
    await this.ensureRowMeta({ rowId, requestUrl });
    const row = await this.kv.get<Row>(rowMetaKey(rowId));
    if (!row) {
      error(404, "BAD_REQUEST", `Row ${rowId} does not exist`);
    }

    return row;
  }

  private async ensureRowMeta(args: {
    rowId: string;
    rowName?: string;
    requestUrl?: string;
  }): Promise<void> {
    const key = rowMetaKey(args.rowId);
    const inferredBaseUrl = args.requestUrl
      ? inferFederationWorkerBaseUrlFromRequest(args.requestUrl, this.config.workerUrl)
      : this.config.workerUrl
        ? stripTrailingSlash(this.config.workerUrl)
        : undefined;
    const existing = await this.kv.get<Row>(key);

    if (existing) {
      if (inferredBaseUrl && existing.baseUrl !== inferredBaseUrl) {
        await this.kv.set(key, {
          ...existing,
          baseUrl: inferredBaseUrl,
        });
      }
      return;
    }

    if (!args.rowName) {
      error(404, "BAD_REQUEST", `Row ${args.rowId} does not exist`);
    }
    if (!inferredBaseUrl) {
      error(500, "BAD_REQUEST", `Unable to infer baseUrl for row ${args.rowId}`);
    }

    const row: Row = {
      id: args.rowId,
      name: args.rowName,
      owner: this.config.owner,
      baseUrl: inferredBaseUrl,
      createdAt: this.now(),
    };

    await this.kv.set(key, row);
  }

  private async snapshot(rowId: string, requestUrl?: string): Promise<RowSnapshot> {
    await this.ensureRowMeta({ rowId, requestUrl });

    const row = await this.kv.get<Row>(rowMetaKey(rowId));
    if (!row) {
      error(400, "BAD_REQUEST", "Row metadata missing");
    }

    const members = await this.getMembers(rowId);
    return {
      ...row,
      collection: await this.getRowCollection(rowId),
      members,
      parentRefs: await this.getParentRefs(rowId),
    };
  }
}
