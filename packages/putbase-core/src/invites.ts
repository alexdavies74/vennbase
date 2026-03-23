import type { Identity } from "./identity";
import type { PutBaseOptions } from "./putbase";
import type { Transport } from "./transport";
import type { RowRef } from "./schema";
import { normalizeRowRef } from "./row-reference";
import type { ParsedInvite, InviteToken } from "./types";

export const PUTBASE_INVITE_TARGET_PARAM = "pb";

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
    private readonly options: Pick<PutBaseOptions, "appBaseUrl">,
    private readonly transport: Transport,
    private readonly identity: Identity,
  ) {}

  async getExistingInviteToken(row: RowRef): Promise<InviteToken | null> {
    const response = await this.transport.row(row).request<GetInviteResponse>("invite-token/get", {});
    return response.inviteToken;
  }

  async createInviteTokenRemote(row: RowRef, payload: InviteToken): Promise<InviteToken> {
    const response = await this.transport.row(row).request<PostInviteResponse>("invite-token/create", payload);

    return response.inviteToken;
  }

  createInviteLink(row: RowRef, inviteToken: string): string {
    const appBaseUrl =
      this.options.appBaseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");

    const url = new URL("/", appBaseUrl);
    url.searchParams.set(PUTBASE_INVITE_TARGET_PARAM, JSON.stringify({
      ref: normalizeRowRef(row),
      inviteToken,
    } satisfies ParsedInvite));
    return url.toString();
  }

  parseInvite(input: string): ParsedInvite {
    const trimmed = input.trim();
    const url = new URL(trimmed);
    const payload = url.searchParams.get(PUTBASE_INVITE_TARGET_PARAM);

    if (!payload) {
      throw new Error("Invite input must include a PutBase invite payload.");
    }

    return parseInvitePayload(payload);
  }
}
