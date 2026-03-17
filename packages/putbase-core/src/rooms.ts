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

    await this.transport.request({
      url: `${federationWorkerUrl}/rooms`,
      action: "rooms.create",
      roomId,
      payload: {
        roomId,
        roomName: name,
      },
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

    await this.transport.request({
      url: `${stripTrailingSlash(workerUrl)}/join`,
      action: "rooms.join",
      roomId: roomIdFromWorkerUrl(workerUrl),
      payload: {
        username: user.username,
        inviteToken: options.inviteToken,
      },
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
    return this.transport.request<RoomSnapshot>({
      url: `${stripTrailingSlash(workerUrl)}/room`,
      action: "rooms.room",
      roomId: roomIdFromWorkerUrl(workerUrl),
      payload: {},
    });
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
      {
        url: `${stripTrailingSlash(workerUrl)}/message`,
        action: "rooms.message",
        roomId,
        payload,
      },
    );

    return response.message;
  }

  async pollMessages(
    workerUrl: string,
    sinceSequence: number,
  ): Promise<{ messages: Array<{ body: unknown; sequence: number; createdAt: number; id: string }>; latestSequence: number }> {
    return this.transport.request({
      url: `${stripTrailingSlash(workerUrl)}/messages`,
      action: "rooms.messages",
      roomId: roomIdFromWorkerUrl(workerUrl),
      payload: {
        sinceSequence,
      },
    });
  }
}

function buildRoomWorkerUrl(federationWorkerBaseUrl: string, roomId: string): string {
  return `${stripTrailingSlash(federationWorkerBaseUrl)}/rooms/${encodeURIComponent(roomId)}`;
}

function roomIdFromWorkerUrl(workerUrl: string): string {
  const parsed = new URL(workerUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");
  if (roomsIndex < 0 || roomsIndex + 1 >= segments.length) {
    throw new Error(`Unsupported room worker URL: ${workerUrl}`);
  }

  return decodeURIComponent(segments[roomsIndex + 1]);
}
