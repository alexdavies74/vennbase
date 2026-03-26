import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderStaticPage } from "../src/render-static";

function loadTemplate(pathname: string): string {
  return readFileSync(new URL(pathname, import.meta.url), "utf8");
}

function loadCoreReadme(): string {
  return readFileSync(new URL("../../vennbase-core/README.md", import.meta.url), "utf8");
}

function renderTemplate(pathname: "/" | "/reference/"): string {
  const templatePath = pathname === "/" ? "../index.html" : "../reference/index.html";
  const template = loadTemplate(templatePath);
  return template.replace('<div id="app"></div>', `<div id="app">${renderStaticPage(pathname, loadCoreReadme())}</div>`);
}

describe("renderStaticPage", () => {
  it("renders the homepage content into the HTML shell", () => {
    const html = renderTemplate("/");

    expect(html).toContain("Build multi-user apps without writing a single access rule.");
    expect(html).toContain("Zero backend");
    expect(html).toContain('<section class="hero">');
    expect(html).toContain("For coding agents");
    expect(html).toContain("Copy prompt");
  });

  it("renders the reference page content into the HTML shell", () => {
    const html = renderTemplate("/reference/");

    expect(html).toContain("<title>Vennbase Reference</title>");
    expect(html).toContain('href="#vennbase"');
    expect(html).toContain("MutationReceipt&lt;T&gt;");
    expect(html).not.toContain('<script type="module"');
  });
});
