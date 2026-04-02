import type { Identity } from "./identity.js";
import { fromBase64Url, toBase64Url } from "./crypto.js";
import { normalizeBaseUrl } from "./transport.js";
import type { VennbaseOptions } from "./vennbase.js";
import type { Transport } from "./transport.js";
import type { MemberRole, RowInput, RowRef } from "./schema.js";
import { normalizeRowRef } from "./row-reference.js";
import type { ParsedInvite, ShareToken } from "./types.js";

export const VENNBASE_INVITE_TARGET_PARAM = "db";

interface GetInviteResponse {
  inviteToken: ShareToken | null;
}

interface PostInviteResponse {
  inviteToken: ShareToken;
}

interface GetInvitePayload {
  role: MemberRole;
}

const INVITE_PAYLOAD_VERSION = "1";
const INVITE_SEGMENT_DELIMITER = "*";
const HOST_WORKER_LOCATOR_PREFIX = "h";
const URL_WORKER_LOCATOR_PREFIX = "u";
const ENCODED_SEGMENT_PREFIX = "_";
const ROW_ID_PREFIX = "row_";
const SHARE_TOKEN_PREFIX = "invite_";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const RAW_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

function encodeTextBase64Url(value: string): string {
  return toBase64Url(textEncoder.encode(value));
}

function decodeTextBase64Url(value: string): string {
  return textDecoder.decode(fromBase64Url(value));
}

function assertInviteSegmentSafe(value: string, fieldName: string): void {
  if (!value) {
    throw new Error(`Invite payload must include a ${fieldName}.`);
  }

  if (!RAW_SEGMENT_PATTERN.test(value) || value.startsWith(ENCODED_SEGMENT_PREFIX)) {
    throw new Error(`Invite ${fieldName} uses reserved characters.`);
  }
}

function encodeGenericSegment(value: string): string {
  return RAW_SEGMENT_PATTERN.test(value) && !value.startsWith(ENCODED_SEGMENT_PREFIX)
    ? value
    : `${ENCODED_SEGMENT_PREFIX}${encodeTextBase64Url(value)}`;
}

function decodeGenericSegment(value: string, fieldName: string): string {
  if (!value) {
    throw new Error(`Invite payload must include a ${fieldName}.`);
  }

  return value.startsWith(ENCODED_SEGMENT_PREFIX)
    ? decodeTextBase64Url(value.slice(ENCODED_SEGMENT_PREFIX.length))
    : value;
}

function encodeRowId(rowId: string): string {
  if (rowId.startsWith(ROW_ID_PREFIX)) {
    const tail = rowId.slice(ROW_ID_PREFIX.length);
    if (tail) {
      assertInviteSegmentSafe(tail, "row id");
      return tail;
    }
  }

  return `${ENCODED_SEGMENT_PREFIX}${encodeTextBase64Url(rowId)}`;
}

function decodeRowId(value: string): string {
  if (!value) {
    throw new Error("Invite payload must include a row id.");
  }

  return value.startsWith(ENCODED_SEGMENT_PREFIX)
    ? decodeTextBase64Url(value.slice(ENCODED_SEGMENT_PREFIX.length))
    : `${ROW_ID_PREFIX}${value}`;
}

function encodeShareToken(value: string | undefined): string {
  if (!value) {
    return "";
  }

  if (value.startsWith(SHARE_TOKEN_PREFIX)) {
    const tail = value.slice(SHARE_TOKEN_PREFIX.length);
    if (tail) {
      assertInviteSegmentSafe(tail, "share token");
      return tail;
    }
  }

  return `${ENCODED_SEGMENT_PREFIX}${encodeTextBase64Url(value)}`;
}

function decodeShareToken(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.startsWith(ENCODED_SEGMENT_PREFIX)
    ? decodeTextBase64Url(value.slice(ENCODED_SEGMENT_PREFIX.length))
    : `${SHARE_TOKEN_PREFIX}${value}`;
}

function encodeWorkerLocator(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const parsed = new URL(normalized);

  if (
    parsed.protocol === "https:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
  ) {
    return `${HOST_WORKER_LOCATOR_PREFIX}${parsed.host}`;
  }

  return `${URL_WORKER_LOCATOR_PREFIX}${encodeTextBase64Url(normalized)}`;
}

function decodeWorkerLocator(locator: string): string {
  if (locator.startsWith(HOST_WORKER_LOCATOR_PREFIX)) {
    const host = locator.slice(HOST_WORKER_LOCATOR_PREFIX.length);
    if (!host) {
      throw new Error("Invite payload must include a worker host.");
    }

    return normalizeBaseUrl(new URL(`https://${host}`).toString());
  }

  if (locator.startsWith(URL_WORKER_LOCATOR_PREFIX)) {
    const encoded = locator.slice(URL_WORKER_LOCATOR_PREFIX.length);
    if (!encoded) {
      throw new Error("Invite payload must include a worker URL.");
    }

    const decoded = decodeTextBase64Url(encoded);
    return normalizeBaseUrl(new URL(decoded).toString());
  }

  throw new Error("Invite payload has an invalid worker locator.");
}

function serializeInvitePayload(invite: ParsedInvite): string {
  const ref = normalizeRowRef(invite.ref);

  return [
    INVITE_PAYLOAD_VERSION,
    encodeRowId(ref.id),
    encodeGenericSegment(ref.collection),
    encodeShareToken(invite.shareToken),
    encodeWorkerLocator(ref.baseUrl),
  ].join(INVITE_SEGMENT_DELIMITER);
}

function parseInvitePayload(input: string): ParsedInvite {
  const [version, id, collection, shareToken, locator, ...rest] = input.split(INVITE_SEGMENT_DELIMITER);

  if (rest.length > 0 || !version || !id || !collection || locator === undefined) {
    throw new Error("Invite payload is malformed.");
  }

  if (version !== INVITE_PAYLOAD_VERSION) {
    throw new Error(`Invite payload version "${version}" is unsupported.`);
  }

  return {
    ref: normalizeRowRef({
      id: decodeRowId(id),
      collection: decodeGenericSegment(collection, "collection"),
      baseUrl: decodeWorkerLocator(locator),
    }),
    shareToken: decodeShareToken(shareToken),
  };
}

export class Invites {
  constructor(
    private readonly options: Pick<VennbaseOptions, "appBaseUrl">,
    private readonly transport: Transport,
    private readonly identity: Identity,
  ) {}

  async getExistingShareToken(row: RowInput, role: MemberRole): Promise<ShareToken | null> {
    const response = await this.transport.row(normalizeRowRef(row)).request<GetInviteResponse, GetInvitePayload>(
      "invite-token/get",
      { role },
    );
    return response.inviteToken;
  }

  async createShareTokenRemote(row: RowInput, payload: ShareToken): Promise<ShareToken> {
    const response = await this.transport.row(normalizeRowRef(row)).request<PostInviteResponse>("invite-token/create", payload);

    return response.inviteToken;
  }

  createShareLink(row: RowInput, shareToken: string): string {
    const appBaseUrl =
      this.options.appBaseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");

    const url = new URL("/", appBaseUrl);
    url.searchParams.set(VENNBASE_INVITE_TARGET_PARAM, serializeInvitePayload({
      ref: normalizeRowRef(row),
      shareToken,
    } satisfies ParsedInvite));
    return url.toString();
  }

  parseInvite(input: string): ParsedInvite {
    const trimmed = input.trim();
    const url = new URL(trimmed);
    const payload = url.searchParams.get(VENNBASE_INVITE_TARGET_PARAM);

    if (!payload) {
      throw new Error("Invite input must include a Vennbase invite payload.");
    }

    return parseInvitePayload(payload);
  }
}
