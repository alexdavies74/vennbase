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

    expect(script).toMatch(/router\.get\((\"|')\/room(\"|')/);
    expect(script).toMatch(/router\.post\((\"|')\/message(\"|')/);
    expect(script).toContain("me.puter.kv.get(");
    expect(script).toContain("me.puter.kv.set(");
    expect(script).toContain("me.puter.kv.incr(");
    expect(script).toContain("me.puter.kv.list(");
    expect(script).toContain("\"room_1\"");
    expect(script).toContain("\"Room Name\"");
    expect(script).toContain("\"owner\"");
    expect(script).toContain("\"https://workers.puter.site/owner/room-room_1\"");
    expect(script).not.toContain("__PUTER_FED_ROOM_ID__");
    expect(script).not.toContain("__PUTER_FED_ROOM_NAME__");
    expect(script).not.toContain("__PUTER_FED_ROOM_OWNER__");
    expect(script).not.toContain("__PUTER_FED_ROOM_WORKER_URL__");

    expect(script).not.toMatch(/(^|[^\w.])puter\.router\./);
    expect(script).not.toMatch(/(^|[^\w.])puter\.kv\./);
  });
});
