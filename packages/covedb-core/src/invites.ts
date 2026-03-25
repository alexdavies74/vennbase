import type { Identity } from "./identity";
import type { CoveDBOptions } from "./covedb";
import type { Transport } from "./transport";
import type { RowInput, RowRef } from "./schema";
import { normalizeRowRef } from "./row-reference";
import type { ParsedInvite, InviteToken } from "./types";

export const COVEDB_INVITE_TARGET_PARAM = "db";

interface GetInviteResponse {
  inviteToken: InviteToken | null;
}

interface PostInviteResponse {
  inviteToken: InviteToken;
}

function isRowRefLike(value: unknown): value is RowRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.collection === "string"
    && typeof record.baseUrl === "string";
}

function parseInvitePayload(input: string): ParsedInvite {
  const parsed = JSON.parse(input) as { ref?: unknown; inviteToken?: unknown };
  if (!isRowRefLike(parsed?.ref)) {
    throw new Error("Invite payload must include a row ref.");
  }

  return {
    ref: normalizeRowRef(parsed.ref),
    inviteToken: typeof parsed.inviteToken === "string" ? parsed.inviteToken : undefined,
  };
}

export class Invites {
  constructor(
    private readonly options: Pick<CoveDBOptions, "appBaseUrl">,
    private readonly transport: Transport,
    private readonly identity: Identity,
  ) {}

  async getExistingInviteToken(row: RowInput): Promise<InviteToken | null> {
    const response = await this.transport.row(normalizeRowRef(row)).request<GetInviteResponse>("invite-token/get", {});
    return response.inviteToken;
  }

  async createInviteTokenRemote(row: RowInput, payload: InviteToken): Promise<InviteToken> {
    const response = await this.transport.row(normalizeRowRef(row)).request<PostInviteResponse>("invite-token/create", payload);

    return response.inviteToken;
  }

  createShareLink(row: RowInput, inviteToken: string): string {
    const appBaseUrl =
      this.options.appBaseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");

    const url = new URL("/", appBaseUrl);
    url.searchParams.set(COVEDB_INVITE_TARGET_PARAM, JSON.stringify({
      ref: normalizeRowRef(row),
      inviteToken,
    } satisfies ParsedInvite));
    return url.toString();
  }

  parseInvite(input: string): ParsedInvite {
    const trimmed = input.trim();
    const url = new URL(trimmed);
    const payload = url.searchParams.get(COVEDB_INVITE_TARGET_PARAM);

    if (!payload) {
      throw new Error("Invite input must include a CoveDB invite payload.");
    }

    return parseInvitePayload(payload);
  }
}
