import { describe, expect, it } from "vitest";

import { buildClassicWorkerScript } from "../src/worker/template";

describe("buildClassicWorkerScript", () => {
  it("uses documented Puter worker globals", () => {
    const script = buildClassicWorkerScript({
      owner: "owner",
      ownerPublicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    });

    expect(script).toMatch(/router\.post\((\"|')\/rows(\"|')/);
    expect(script).toMatch(/router\.post\((\"|')\/rows\/:rowId\/row\/get(\"|')/);
    expect(script).toMatch(/router\.post\((\"|')\/rows\/:rowId\/sync\/send(\"|')/);
    expect(script).toContain("me.puter.kv.get(");
    expect(script).toContain("me.puter.kv.set(");
    expect(script).toContain("me.puter.kv.incr(");
    expect(script).toContain("me.puter.kv.list(");
    expect(script).toContain("const workersExec = me.puter.workers?.exec;");
    expect(script).toContain("content-type,x-puter-no-auth,puter-auth");
    expect(script).not.toContain("user.puter");
    expect(script).toContain("\"owner\"");
    expect(script).not.toContain("__PUTER_FED_ROW_OWNER__");

    expect(script).not.toMatch(/(^|[^\w.])puter\.router\./);
    expect(script).not.toMatch(/(^|[^\w.])puter\.kv\./);
  });
});
