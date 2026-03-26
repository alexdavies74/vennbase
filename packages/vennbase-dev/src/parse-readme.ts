export interface ReadmeSection {
  heading: string;
  slug: string;
  markdown: string;
}

export interface ReferenceSubsection {
  heading: string;
  slug: string;
  markdown: string;
}

export interface ParsedReadme {
  title: string;
  tagline: string;
  lead: string;
  supportingLine: string;
  heroCode: string;
  featureBullets: string[];
  sections: ReadmeSection[];
  reference: {
    heading: string;
    introMarkdown: string;
    sections: ReferenceSubsection[];
  };
}

interface SplitSection {
  heading: string;
  body: string;
}

export function parseReadme(markdown: string): ParsedReadme {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));

  if (!titleLine) {
    throw new Error("README is missing a top-level title.");
  }

  const title = titleLine.replace(/^#\s+/, "").trim();
  const splitSections = splitByHeading(lines, "## ");
  const introMarkdown = splitSections.intro.join("\n").trim();
  const sections = splitSections.sections.map(({ heading, body }) => ({
    heading,
    slug: slugify(heading),
    markdown: trimMarkdownEdges(body),
  }));

  const introBlocks = splitBlocks(
    introMarkdown
      .replace(/^#\s+.+$/m, "")
      .trim(),
  );
  const tagline = unwrapBold(findMatchingBlock(introBlocks, (block) => /^\*\*.*\*\*$/.test(block))) ?? "";
  const lead = findMatchingBlock(introBlocks, isPlainParagraph) ?? "";
  const supportingLine =
    findMatchingBlock(introBlocks, (block) =>
      isPlainParagraph(block) && block !== lead,
    ) ?? "";
  const heroCode = findMatchingBlock(introBlocks, (block) => block.startsWith("```")) ?? "";
  const featureBullets = parseBulletBlock(
    findMatchingBlock(introBlocks, (block) => /^-\s+/m.test(block)) ?? "",
  );

  const referenceSection = sections.find((section) => section.heading === "API reference");
  if (!referenceSection) {
    throw new Error("README is missing the API reference section.");
  }

  const referenceSplit = splitNestedSections(referenceSection.markdown, "### ");

  return {
    title,
    tagline,
    lead,
    supportingLine,
    heroCode,
    featureBullets,
    sections: sections.filter((section) => section.heading !== "API reference"),
    reference: {
      heading: referenceSection.heading,
      introMarkdown: trimMarkdownEdges(referenceSplit.intro.join("\n")),
      sections: referenceSplit.sections.map(({ heading, body }) => ({
        heading,
        slug: slugify(heading),
        markdown: trimMarkdownEdges(body),
      })),
    },
  };
}

function splitByHeading(lines: string[], prefix: string): { intro: string[]; sections: SplitSection[] } {
  const intro: string[] = [];
  const sections: SplitSection[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(prefix)) {
      if (currentHeading) {
        sections.push({
          heading: currentHeading,
          body: currentLines.join("\n").trim(),
        });
      } else {
        intro.push(...currentLines);
      }

      currentHeading = line.slice(prefix.length).trim();
      currentLines = [];
      continue;
    }

    currentLines.push(line);
  }

  if (currentHeading) {
    sections.push({
      heading: currentHeading,
      body: currentLines.join("\n").trim(),
    });
  } else {
    intro.push(...currentLines);
  }

  return { intro, sections };
}

function splitNestedSections(markdown: string, prefix: string): { intro: string[]; sections: SplitSection[] } {
  return splitByHeading(markdown.split("\n"), prefix);
}

function splitBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      current.push(line);
      continue;
    }

    if (!inFence && line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n").trim());
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current.join("\n").trim());
  }

  return blocks.filter(Boolean);
}

function trimMarkdownEdges(markdown: string): string {
  const blocks = splitBlocks(markdown).filter((block) => block !== "---");
  return blocks.join("\n\n").trim();
}

function findMatchingBlock(blocks: string[], predicate: (block: string) => boolean): string | undefined {
  return blocks.find(predicate);
}

function isPlainParagraph(block: string): boolean {
  return (
    !block.startsWith("```") &&
    !block.startsWith("- ") &&
    block !== "---" &&
    !block.startsWith("**") &&
    !block.startsWith("#") &&
    !block.startsWith("<")
  );
}

function parseBulletBlock(block: string): string[] {
  return block
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").trim());
}

function unwrapBold(block?: string): string | undefined {
  return block?.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[`<>]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
