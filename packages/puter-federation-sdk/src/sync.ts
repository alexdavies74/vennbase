import { createAdaptivePoller } from "./polling";
import type { Rooms } from "./rooms";
import type { CrdtConnectCallbacks, CrdtConnection, Message } from "./types";
import type { DbRowLocator } from "./schema";

export class Sync {
  constructor(private readonly rooms: Rooms) {}

  connectCrdt(row: DbRowLocator, callbacks: CrdtConnectCallbacks): CrdtConnection {
    let lastSequence = 0;

    const poller = createAdaptivePoller({
      run: async ({ markActivity }) => {
        const poll = await this.rooms.pollMessages(row.workerUrl, lastSequence);
        const messages = poll.messages.slice().sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        );

        for (const message of messages) {
          callbacks.applyRemoteUpdate(
            message.body as Message["body"],
            message as unknown as Message,
          );
        }

        if (messages.length > 0) {
          markActivity();
        }

        lastSequence = poll.latestSequence;

        const update = callbacks.produceLocalUpdate();
        if (update !== null) {
          const sent = await this.rooms.sendMessage(row.workerUrl, row.id, update);
          lastSequence = Math.max(lastSequence, sent.sequence);
          markActivity();
        }
      },
    });

    return {
      disconnect() {
        poller.disconnect();
      },
      flush: () => poller.refresh(),
    };
  }
}
