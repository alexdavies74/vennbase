import { describe, expect, it } from "vitest";

import { buildClassicWorkerScript } from "../src/worker/template";

describe("buildClassicWorkerScript", () => {
  it("uses documented Puter worker globals", () => {
    const script = buildClassicWorkerScript({
      roomId: "room_1",
      roomName: "Room Name",
      owner: "owner",
      workerUrl: "https://workers.puter.site/owner/room-room_1",
    });

    expect(script).toContain("router.get(\"/room\"");
    expect(script).toContain("router.post(\"/message\"");
    expect(script).toContain("me.puter.kv.get(");
    expect(script).toContain("me.puter.kv.set(");
    expect(script).toContain("me.puter.kv.list(messagePrefix(), true)");

    expect(script).not.toMatch(/(^|[^\w.])puter\.router\./);
    expect(script).not.toMatch(/(^|[^\w.])puter\.kv\./);
  });
});
