import type { Identity } from "./identity";
import type { Transport } from "./transport";
import { stripTrailingSlash } from "./transport";
import type { InviteToken, ParsedInviteInput, PuterFedRoomsOptions } from "./types";
import type { DbRowLocator } from "./schema";

interface GetInviteResponse {
  inviteToken: InviteToken | null;
}

interface PostInviteResponse {
  inviteToken: InviteToken;
}

function normalizeWorkerUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/g, "");
}

function assertRoomWorkerUrl(workerUrl: string): void {
  const parsed = new URL(workerUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");
  if (roomsIndex < 0 || roomsIndex + 1 >= segments.length) {
    throw new Error("Invite input must include a room worker URL.");
  }
}

export class Invites {
  constructor(
    private readonly options: PuterFedRoomsOptions,
    private readonly transport: Transport,
    private readonly identity: Identity,
  ) {}

  async getExistingInviteToken(row: DbRowLocator): Promise<InviteToken | null> {
    const response = await this.transport.request<GetInviteResponse>(
      `${stripTrailingSlash(row.workerUrl)}/invite-token`,
      "GET",
    );
    return response.inviteToken;
  }

  async createInviteToken(row: DbRowLocator): Promise<InviteToken> {
    const user = await this.identity.whoAmI();

    const payload: InviteToken = {
      token: this.transport.createId("invite"),
      roomId: row.id,
      invitedBy: user.username,
      createdAt: Date.now(),
    };

    const response = await this.transport.request<PostInviteResponse>(
      `${stripTrailingSlash(row.workerUrl)}/invite-token`,
      "POST",
      payload,
    );

    return response.inviteToken;
  }

  createInviteLink(row: Pick<DbRowLocator, "workerUrl">, inviteToken: string): string {
    const appBaseUrl =
      this.options.appBaseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:5173");

    const url = new URL("/", appBaseUrl);
    url.searchParams.set("worker", normalizeWorkerUrl(row.workerUrl));
    url.searchParams.set("token", inviteToken);
    return url.toString();
  }

  parseInviteInput(input: string): ParsedInviteInput {
    const trimmed = input.trim();
    const url = new URL(trimmed);

    const inviteToken = url.searchParams.get("token") ?? undefined;
    const workerUrl = url.searchParams.get("worker");

    if (workerUrl) {
      assertRoomWorkerUrl(workerUrl);
      return {
        workerUrl: normalizeWorkerUrl(workerUrl),
        inviteToken,
      };
    }

    if (url.searchParams.has("owner") || url.searchParams.has("room")) {
      throw new Error(
        "Invite links with owner/room parameters are no longer supported. Use worker-based invite links.",
      );
    }

    const directWorkerUrl = new URL(url.toString());
    directWorkerUrl.searchParams.delete("token");
    assertRoomWorkerUrl(directWorkerUrl.toString());

    return {
      workerUrl: normalizeWorkerUrl(directWorkerUrl.toString()),
      inviteToken,
    };
  }
}
