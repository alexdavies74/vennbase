import type { Identity } from "./identity";
import type { Provisioning } from "./provisioning";
import type { Transport } from "./transport";
import { stripTrailingSlash } from "./transport";
import type { JoinOptions, Room, RoomSnapshot } from "./types";

interface PostMessageResponse {
  message: { sequence: number };
}

export class Rooms {
  constructor(
    private readonly transport: Transport,
    private readonly identity: Identity,
    private readonly provisioning: Provisioning,
    private readonly ensureReady: () => Promise<void>,
  ) {}

  async createRoom(name: string): Promise<Room> {
    await this.ensureReady();

    const user = await this.identity.whoAmI();
    const federationWorkerUrl = await this.provisioning.getFederationWorkerUrl(user.username);
    const roomId = this.transport.createId("room");
    const roomWorkerUrl = buildRoomWorkerUrl(federationWorkerUrl, roomId);

    await this.transport.request(`${federationWorkerUrl}/rooms`, "POST", {
      roomId,
      roomName: name,
    });

    await this.joinRoom(roomWorkerUrl, {});

    const room = await this.getRoom(roomWorkerUrl);
    return {
      id: room.id,
      name: room.name,
      owner: room.owner,
      workerUrl: room.workerUrl,
      createdAt: room.createdAt,
    };
  }

  async joinRoom(workerUrl: string, options: JoinOptions = {}): Promise<Room> {
    const user = await this.identity.whoAmI();

    await this.transport.request(`${stripTrailingSlash(workerUrl)}/join`, "POST", {
      username: user.username,
      inviteToken: options.inviteToken,
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

  async getRoom(workerUrl: string): Promise<RoomSnapshot> {
    return this.transport.request<RoomSnapshot>(
      `${stripTrailingSlash(workerUrl)}/room`,
      "GET",
    );
  }

  async listMembers(workerUrl: string): Promise<string[]> {
    const snapshot = await this.getRoom(workerUrl);
    return snapshot.members;
  }

  async sendMessage(workerUrl: string, roomId: string, body: unknown): Promise<{ sequence: number }> {
    const payload = {
      id: this.transport.createId("msg"),
      roomId,
      body,
      createdAt: Date.now(),
    };

    const response = await this.transport.request<PostMessageResponse>(
      `${stripTrailingSlash(workerUrl)}/message`,
      "POST",
      payload,
    );

    return response.message;
  }

  async pollMessages(
    workerUrl: string,
    sinceSequence: number,
  ): Promise<{ messages: Array<{ body: unknown; sequence: number; createdAt: number; id: string }>; latestSequence: number }> {
    return this.transport.request(
      `${stripTrailingSlash(workerUrl)}/messages?sinceSequence=${encodeURIComponent(String(sinceSequence))}`,
      "GET",
    );
  }
}

function buildRoomWorkerUrl(federationWorkerBaseUrl: string, roomId: string): string {
  return `${stripTrailingSlash(federationWorkerBaseUrl)}/rooms/${encodeURIComponent(roomId)}`;
}
