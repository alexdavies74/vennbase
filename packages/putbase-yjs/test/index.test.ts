import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createYjsAdapter, type YjsModule } from "../src/index";

function decodeBody(body: unknown): Uint8Array | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  if (record.type !== "yjs-update" || typeof record.data !== "string") {
    return null;
  }

  const binary = atob(record.data);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function createRuntime() {
  const mergeUpdates = vi.fn((updates: Uint8Array[]) => Y.mergeUpdates(updates));

  return {
    runtime: {
      Doc: Y.Doc,
      applyUpdate: Y.applyUpdate,
      mergeUpdates,
    } satisfies YjsModule<Y.Doc>,
    mergeUpdates,
  };
}

describe("@putbase/yjs", () => {
  it("buffers and encodes merged local updates", () => {
    const { runtime, mergeUpdates } = createRuntime();
    const binding = createYjsAdapter(runtime);
    const doc = binding.getValue();
    const text = doc.getText("messages");

    text.insert(0, "hello");
    text.insert(5, " world");

    const encoded = binding.callbacks.produceLocalUpdate();
    const update = decodeBody(encoded);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, update as Uint8Array);

    expect(mergeUpdates).toHaveBeenCalled();
    expect(restored.getText("messages").toString()).toBe("hello world");
    expect(binding.callbacks.produceLocalUpdate()).toBeNull();
  });

  it("applies remote updates without re-queueing them locally", () => {
    const { runtime } = createRuntime();
    const binding = createYjsAdapter(runtime);
    const notifications = vi.fn();
    const unsubscribe = binding.subscribe(notifications);
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("messages").insert(0, "remote");

    binding.callbacks.applyRemoteUpdate({
      type: "yjs-update",
      data: btoa(Array.from(Y.encodeStateAsUpdate(remoteDoc), (value) => String.fromCharCode(value)).join("")),
    }, {
      id: "msg_1",
      rowId: "row_1",
      body: null,
      createdAt: 1,
      signedBy: "friend",
      sequence: 1,
    });

    expect(binding.getValue().getText("messages").toString()).toBe("remote");
    expect(binding.getVersion()).toBeGreaterThan(0);
    expect(notifications).toHaveBeenCalled();
    expect(binding.callbacks.produceLocalUpdate()).toBeNull();

    unsubscribe();
  });

  it("ignores malformed messages and resets to a fresh doc", () => {
    const { runtime } = createRuntime();
    const binding = createYjsAdapter(runtime);
    const originalDoc = binding.getValue();

    binding.getValue().getText("messages").insert(0, "hello");
    expect(binding.callbacks.produceLocalUpdate()).not.toBeNull();

    binding.callbacks.applyRemoteUpdate({ type: "not-yjs", data: "AAAA" }, {
      id: "msg_1",
      rowId: "row_1",
      body: null,
      createdAt: 1,
      signedBy: "friend",
      sequence: 1,
    });

    binding.reset();

    expect(binding.getValue()).not.toBe(originalDoc);
    expect(binding.getValue().getText("messages").toString()).toBe("");
    expect(binding.callbacks.produceLocalUpdate()).toBeNull();
  });
});
