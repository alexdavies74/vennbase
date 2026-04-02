import { createAdaptivePoller } from "./polling.js";
import type { RowRuntime } from "./row-runtime.js";
import type { CrdtConnectCallbacks, CrdtConnection, SyncMessage } from "./types.js";
import type { RowInput } from "./schema.js";
import { normalizeRowRef } from "./row-reference.js";

export class Sync {
  constructor(private readonly rowRuntime: RowRuntime) {}

  connectCrdt(row: RowInput, callbacks: CrdtConnectCallbacks): CrdtConnection {
    const rowRef = normalizeRowRef(row);
    let lastSequence = 0;

    const poller = createAdaptivePoller({
      run: async ({ markActivity }) => {
        const poll = await this.rowRuntime.pollSyncMessages(rowRef, lastSequence);
        const messages = poll.messages.slice().sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        );

        for (const message of messages) {
          callbacks.applyRemoteUpdate(
            message.body as SyncMessage["body"],
            message as unknown as SyncMessage,
          );
        }

        if (messages.length > 0) {
          markActivity();
        }

        lastSequence = poll.latestSequence;

        const update = callbacks.produceLocalUpdate();
        if (update !== null) {
          const sent = await this.rowRuntime.sendSyncMessage(rowRef, update);
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
