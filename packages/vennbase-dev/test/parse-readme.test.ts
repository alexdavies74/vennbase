import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReadme } from "../src/parse-readme";

function loadCoreReadme(): string {
  return readFileSync(new URL("../../vennbase-core/README.md", import.meta.url), "utf8");
}

describe("parseReadme", () => {
  it("extracts the hero content from the intro block", () => {
    const parsed = parseReadme(loadCoreReadme());

    expect(parsed.title).toBe("Vennbase");
    expect(parsed.tagline).toBe("Build multi-user apps without writing a single access rule.");
    expect(parsed.lead).toContain("TypeScript client-side database for collaborative, local-first web apps");
    expect(parsed.supportingLine).toBe("Write your frontend. Vennbase handles the rest.");
    expect(parsed.heroCode).toContain('const board = db.create("boards"');
    expect(parsed.featureBullets).toContain("**Zero backend** — no server to run, no infrastructure bill");
  });

  it("moves the API reference off the homepage sections", () => {
    const parsed = parseReadme(loadCoreReadme());

    expect(parsed.sections.some((section) => section.heading === "API reference")).toBe(false);
    expect(parsed.sections.map((section) => section.heading)).toContain("How it works");
    expect(parsed.reference.heading).toBe("API reference");
    expect(parsed.reference.sections.map((section) => section.heading)).toEqual([
      "`Vennbase`",
      "`RowHandle`",
      "`MutationReceipt<T>`",
    ]);
  });

  it("preserves nested API subsections when more are added", () => {
    const readme = `${loadCoreReadme()}\n\n### \`ShareToken\`\n\n| Member | Description |\n|--------|-------------|\n| \`.token\` | Share token string. |\n`;
    const parsed = parseReadme(readme);

    expect(parsed.reference.sections.at(-1)?.heading).toBe("`ShareToken`");
    expect(parsed.reference.sections.at(-1)?.markdown).toContain("Share token string.");
  });
});
