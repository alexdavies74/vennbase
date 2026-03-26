import { Children, type ComponentPropsWithoutRef, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { ParsedReadme, ReadmeSection, ReferenceSubsection } from "./parse-readme";

const AGENT_PROMPT_SNIPPET = [
  "Use @vennbase/react and @vennbase/core for data, and puter.js for other backend needs. See https://registry.npmjs.org/@vennbase/core",
  "Don't write a backend! Use only vennbase/puter.",
].join("\n");

interface MarkdownCardProps {
  title: string;
  markdown: string;
  slug: string;
  tone: string;
  eyebrow?: string;
  className?: string;
}

interface MarkdownContentProps {
  markdown: string;
}

const markdownComponents = {
  a: ({ node: _node, href, children, ...props }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => {
    const external = Boolean(href?.startsWith("http"));
    return (
      <a
        {...props}
        href={href}
        rel={external ? "noreferrer" : undefined}
        target={external ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  },
  img: ({ node: _node, src, alt, ...props }: ComponentPropsWithoutRef<"img"> & { node?: unknown }) => (
    <img
      {...props}
      alt={alt}
      className="markdown-image"
      src={resolveReadmeAssetUrl(src)}
    />
  ),
  code: ({
    node: _node,
    className,
    children,
    ...props
  }: ComponentPropsWithoutRef<"code"> & { node?: unknown }) => {
    const isBlock = Boolean(className?.includes("language-"));
    if (isBlock) {
      return (
        <code {...props} className={className}>
          {children}
        </code>
      );
    }

    return (
      <code {...props} className={["inline-code", className].filter(Boolean).join(" ")}>
        {children}
      </code>
    );
  },
  pre: ({ node: _node, children, ...props }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) => {
    const language = getCodeLanguage(children);
    return (
      <div className="code-frame">
        <div className="code-frame__bar">
          <span className="code-frame__label">{language ?? "snippet"}</span>
          <span className="code-frame__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
        <pre {...props}>{children}</pre>
      </div>
    );
  },
  table: ({ node: _node, children, ...props }: ComponentPropsWithoutRef<"table"> & { node?: unknown }) => (
    <div className="table-scroll">
      <table {...props}>{children}</table>
    </div>
  ),
} satisfies Parameters<typeof ReactMarkdown>[0]["components"];

export function HomePage({ content }: { content: ParsedReadme }) {
  const featuredHeadings = new Set([
    "How it works",
    "Schema",
    "Querying",
    "Sharing rows with share links",
  ]);
  const featuredSections = content.sections.filter((section) => featuredHeadings.has(section.heading));
  const remainingSections = content.sections.filter(
    (section) => section.heading !== "Install" && !featuredHeadings.has(section.heading),
  );

  return (
    <div className="site-shell">
      <div className="site-backdrop" aria-hidden="true" />
      <div className="site-grid" aria-hidden="true" />
      <header className="hero-wrap">
        <TopNav />
        <section className="hero">
          <div className="hero-copy">
            <img
              className="hero-mark"
              src="/core-assets/mark.svg"
              alt={content.title}
            />
            <p className="hero-tagline">{content.tagline}</p>
            <div className="hero-lead">
              <InlineMarkdown markdown={content.lead} />
            </div>
            <div className="hero-support">
              <InlineMarkdown markdown={content.supportingLine} />
            </div>
            <ul className="feature-list">
              {content.featureBullets.map((feature) => (
                <li key={feature}>
                  <InlineMarkdown markdown={feature} />
                </li>
              ))}
            </ul>
          </div>
          <div className="hero-code">
            <MarkdownContent markdown={content.heroCode} />
          </div>
        </section>
      </header>

      <main className="page-content">
        <section className="prompt-band" aria-label="Coding agent prompt snippet">
          <div className="prompt-band__copy">
            <p className="eyebrow">For coding agents</p>
            <p>
              Paste this into your coding agent so it uses Vennbase and pulls the package docs instead
              of inventing a backend.
            </p>
          </div>
          <div className="prompt-band__panel" data-copy-prompt>
            <div className="prompt-band__controls">
              <textarea
                id="agent-prompt-snippet"
                className="prompt-band__textarea"
                aria-label="Coding agent prompt snippet"
                data-copy-snippet
                readOnly
                rows={1}
                spellCheck={false}
                value={AGENT_PROMPT_SNIPPET}
                wrap="off"
              />
              <button className="prompt-band__button" data-copy-button type="button">
                Copy prompt
              </button>
            </div>
          </div>
        </section>

        <section className="dark-strip">
          <div className="featured-grid">
            {featuredSections.map((section, index) => (
              <MarkdownCard
                key={section.heading}
                className={
                  index === 0
                    ? "section-card--featured section-card--heroic"
                    : "section-card--featured"
                }
                markdown={section.markdown}
                slug={section.slug}
                title={section.heading}
                tone={sectionTone(index)}
              />
            ))}
          </div>
        </section>

        <div className="columns-layout">
          {remainingSections.map((section, index) => (
            <SectionCard
              key={section.heading}
              section={section}
              tone={sectionTone(index + featuredSections.length)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

export function ReferencePage({ content }: { content: ParsedReadme }) {
  return (
    <div className="site-shell site-shell--reference">
      <div className="site-backdrop" aria-hidden="true" />
      <header className="reference-hero">
        <TopNav />
        <div className="reference-hero__content">
          <div>
            <h1>{content.reference.heading}</h1>
          </div>
        </div>
      </header>

      <main className="reference-layout">
        <aside className="reference-nav">
          <nav>
            {content.reference.sections.map((section) => (
              <a key={section.slug} href={`#${section.slug}`}>
                {section.heading}
              </a>
            ))}
          </nav>
        </aside>

        <section className="reference-content">
          {content.reference.introMarkdown ? (
            <div className="reference-intro">
              <MarkdownContent markdown={content.reference.introMarkdown} />
            </div>
          ) : null}
          {content.reference.sections.map((section, index) => (
            <ReferenceCard
              key={section.heading}
              section={section}
              tone={sectionTone(index)}
            />
          ))}
        </section>
      </main>
    </div>
  );
}

function TopNav() {
  return (
    <nav className="top-nav">
      <a className="wordmark" href="/">
        Vennbase
      </a>
      <div className="top-nav__links">
        <a href="/">Overview</a>
        <a href="/reference/">Reference</a>
        <a href="https://github.com/alexdavies74/vennbase/tree/main/packages/vennbase-core">
          GitHub
        </a>
      </div>
    </nav>
  );
}

function SectionCard({ section, tone }: { section: ReadmeSection; tone: string }) {
  return (
    <MarkdownCard
      markdown={section.markdown}
      slug={section.slug}
      title={section.heading}
      tone={tone}
    />
  );
}

function ReferenceCard({ section, tone }: { section: ReferenceSubsection; tone: string }) {
  return (
    <MarkdownCard
      markdown={section.markdown}
      slug={section.slug}
      title={section.heading}
      tone={tone}
    />
  );
}

function MarkdownCard({ title, markdown, slug, tone, eyebrow, className }: MarkdownCardProps) {
  return (
    <article className={["section-card", tone, className].filter(Boolean).join(" ")} id={slug}>
      <div className="section-card__accent" aria-hidden="true" />
      {eyebrow ? <p className="section-card__eyebrow">{eyebrow}</p> : null}
      <h2>
        <InlineMarkdown markdown={title} />
      </h2>
      <MarkdownContent markdown={markdown} />
    </article>
  );
}

function MarkdownContent({ markdown }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      components={markdownComponents}
      rehypePlugins={[rehypeHighlight]}
      remarkPlugins={[remarkGfm]}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function InlineMarkdown({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      components={{
        a: markdownComponents.a,
        code: markdownComponents.code,
        p: ({ children }) => <>{children}</>,
      }}
      remarkPlugins={[remarkGfm]}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function getCodeLanguage(children: ReactNode): string | null {
  const codeChild = Children.toArray(children).find((child): child is ReactElement<{ className?: string }> =>
    isValidElement(child),
  );

  if (!codeChild?.props.className) {
    return null;
  }

  const match = /language-([\w-]+)/.exec(codeChild.props.className);
  return match?.[1] ?? null;
}

function sectionTone(index: number): string {
  const tones = ["tone-mint", "tone-gold", "tone-coral"];
  return tones[index % tones.length] ?? tones[0];
}

function resolveReadmeAssetUrl(src?: string): string | undefined {
  if (!src || isExternalUrl(src) || src.startsWith("/")) {
    return src;
  }

  const normalized = src.replace(/^\.\//, "");
  if (normalized.startsWith("assets/")) {
    return `/${normalized.replace(/^assets\//, "core-assets/")}`;
  }

  return src;
}

function isExternalUrl(url: string): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith("data:");
}
