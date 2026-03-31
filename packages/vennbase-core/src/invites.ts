import type { Identity } from "./identity";
import type { VennbaseOptions } from "./vennbase";
import type { Transport } from "./transport";
import type { MemberRole, RowInput, RowRef } from "./schema";
import { normalizeRowRef } from "./row-reference";
import type { ParsedInvite, ShareToken } from "./types";

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
  const parsed = JSON.parse(input) as { ref?: unknown; shareToken?: unknown };
  if (!isRowRefLike(parsed?.ref)) {
    throw new Error("Invite payload must include a row ref.");
  }

  return {
    ref: normalizeRowRef(parsed.ref),
    shareToken: typeof parsed.shareToken === "string" ? parsed.shareToken : undefined,
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
    url.searchParams.set(VENNBASE_INVITE_TARGET_PARAM, JSON.stringify({
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
