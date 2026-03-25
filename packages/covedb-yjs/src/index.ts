import type { CrdtAdapter, JsonValue } from "@covedb/core";

export interface YjsDocLike {
  on(eventName: "update", listener: (update: Uint8Array, origin: unknown) => void): void;
  off(eventName: "update", listener: (update: Uint8Array, origin: unknown) => void): void;
  destroy(): void;
}

export interface YjsModule<TDoc extends YjsDocLike> {
  Doc: new () => TDoc;
  applyUpdate(doc: TDoc, update: Uint8Array, origin?: unknown): void;
  mergeUpdates(updates: Uint8Array[]): Uint8Array;
}

export interface YjsAdapterOptions {
  messageType?: string;
  remoteOrigin?: unknown;
}

const DEFAULT_MESSAGE_TYPE = "yjs-update";
const DEFAULT_REMOTE_ORIGIN = "covedb-remote-sync";

function encodeUpdate(messageType: string, update: Uint8Array): { type: string; data: string } {
  return {
    type: messageType,
    data: btoa(Array.from(update, (value) => String.fromCharCode(value)).join("")),
  };
}

function decodeUpdate(messageType: string, body: unknown): Uint8Array | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  if (record.type !== messageType || typeof record.data !== "string") {
    return null;
  }

  try {
    const binary = atob(record.data);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function createYjsAdapter<TDoc extends YjsDocLike>(
  yjs: YjsModule<TDoc>,
  options: YjsAdapterOptions = {},
): CrdtAdapter<TDoc> {
  const messageType = options.messageType ?? DEFAULT_MESSAGE_TYPE;
  const remoteOrigin = options.remoteOrigin ?? DEFAULT_REMOTE_ORIGIN;
  const listeners = new Set<() => void>();
  let doc = new yjs.Doc();
  let pendingUpdate: Uint8Array | null = null;
  let version = 0;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== remoteOrigin) {
      pendingUpdate = pendingUpdate
        ? yjs.mergeUpdates([pendingUpdate, update])
        : update;
    }

    version += 1;
    notify();
  };

  const attachDoc = (nextDoc: TDoc) => {
    nextDoc.on("update", handleDocUpdate);
  };

  const detachDoc = (currentDoc: TDoc) => {
    currentDoc.off("update", handleDocUpdate);
  };

  const replaceDoc = (): void => {
    const previousDoc = doc;
    detachDoc(previousDoc);
    pendingUpdate = null;
    doc = new yjs.Doc();
    attachDoc(doc);
    previousDoc.destroy();
    version += 1;
    notify();
  };

  attachDoc(doc);

  return {
    callbacks: {
      applyRemoteUpdate(body: JsonValue) {
        const update = decodeUpdate(messageType, body);
        if (update) {
          yjs.applyUpdate(doc, update, remoteOrigin);
        }
      },
      produceLocalUpdate() {
        const next = pendingUpdate;
        pendingUpdate = null;
        return next ? encodeUpdate(messageType, next) : null;
      },
    },
    getValue() {
      return doc;
    },
    getVersion() {
      return version;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      replaceDoc();
    },
  };
}
