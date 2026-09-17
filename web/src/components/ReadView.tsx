/**
 * ReadView — pure HTML/React render of markdown for the article READ mode.
 *
 * No CodeMirror, no editor chrome, no line numbers — just rendered prose
 * with our typography tokens. When the user clicks Edit, PageView swaps
 * this for the full <Editor /> mounted with edit affordances.
 *
 * Wiki-links are rendered Obsidian-subtle (decision #4): inline with accent
 * color and dotted underline. Code blocks render with the surface-muted
 * background and JetBrains Mono. All colors come from CSS tokens so dark
 * mode looks correct without any extra wiring.
 *
 * ── One renderer (reader UX plan R1.1) ───────────────────────────────────────
 * The reader used to get a strictly weaker surface than the author: a mermaid
 * fence was a grey code block here while the editor's Preview mode rendered it
 * through `@echozedlabs/renderers`. That is fixed by delegating the block kinds
 * react-markdown cannot render *at all* — mermaid diagrams, syntax-highlighted
 * code, and `> [!NOTE]` callouts — to that same package (see ./richBlocks.tsx),
 * so the reader sees exactly what the author saw, produced by the same code.
 *
 * react-markdown + remark-gfm DELIBERATELY STAY as the prose parser rather than
 * being replaced by the package's `renderMarkdownToHtml`, which the plan's R1.1
 * suggested. Verified against renderers@0.3.0 (`markdown.ts`): its block parser
 * is a line scanner with no nested lists, no plain blockquotes (a `>` line that
 * is not a callout becomes a literal `&gt;` paragraph), no thematic breaks, no
 * `<th>` in tables, no footnotes, no multi-paragraph list items, and it eats a
 * leading `---` as frontmatter. Adopting it wholesale would have fixed diagrams
 * by breaking prose — the same defect pointed the other way, on the page the
 * plan calls "the best page in the product". Nothing is swapped: remark-gfm
 * keeps parsing CommonMark + GFM, the renderers package renders the three block
 * kinds it owns, and both halves are the shipped product's own code.
 *
 * PlantUML is NOT wired here: `createPlantUmlRenderer` needs a host
 * `renderPlantUml` service to do the actual rendering, and this product has
 * none (no server endpoint, no `hostServices.renderPlantUml` anywhere). A
 * ```plantuml fence therefore stays a readable code fence, exactly as today.
 */

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HighlightedCode, MermaidFigure } from './richBlocks.js';
import './ReadView.css';

interface ReadViewProps {
  /** Body markdown (frontmatter already stripped). */
  markdown: string;
  /**
   * Existing page slugs, for render-time wiki-link resolution. Wiki-links whose
   * target isn't present render as "red links" (missing) instead of dead links.
   * When omitted, all wiki-links render as normal links (no resolution).
   */
  knownSlugs?: Set<string>;
}

/**
 * Pre-process body markdown to convert wiki-link syntax `[[Title]]` to a
 * standard markdown link with a `data-wiki` attribute we'll style separately.
 * Doing this here (vs. as a remark plugin) keeps the surface tiny.
 */
/** Extract plain text from React children (for heading anchor ids). */
function textOf(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((c) => {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (c && typeof c === 'object' && 'props' in c) return textOf((c as any).props?.children);
      return '';
    })
    .join('');
}

/** Slug for a heading — the id the TOC and "On this page" outline target (features/article/headingOutline.ts). */
export function headingSlug(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function wikiLinksToMarkdown(body: string): string {
  return body.replace(/\[\[([^\[\]\n|]+?)\]\]/g, (_match, title: string) => {
    const slug = title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `[${title}](/p/${slug} "wiki")`;
  });
}

/**
 * `[!NOTE]`, `[!warning]`, … on the first line of a blockquote, with anything
 * after it on THAT line taken as a custom title. Matching horizontal space
 * only is deliberate: `\s*` would swallow the newline and promote the
 * callout's first body line into its title.
 */
const CALLOUT_MARKER = /^\[!(\w+)\][ \t]*([^\n]*)\n?/;

/**
 * remark plugin: turn GitHub/Obsidian callout blockquotes into the renderers
 * package's callout shape.
 *
 * Done as a plugin rather than in the `blockquote` component override because
 * by the time a component runs, its children are already-rendered React nodes —
 * stripping the `[!NOTE]` marker out of them would mean rebuilding the subtree.
 * Here the marker is still one mdast text node, so removing it is a substring.
 *
 * The emitted class names (`me-renderer-callout…`) are the ones
 * `createDefaultRendererRegistry` emits for a callout block, so the editor and
 * the read page style the same thing the same way (ReadView.css owns the
 * reader's take on them).
 */
function remarkCallouts() {
  return (tree: any) => {
    const visit = (node: any) => {
      for (const child of node.children ?? []) {
        if (child.type === 'blockquote') applyCallout(child);
        visit(child);
      }
    };
    visit(tree);
  };
}

function applyCallout(blockquote: any): void {
  const firstBlock = blockquote.children?.[0];
  if (firstBlock?.type !== 'paragraph') return;
  const firstText = firstBlock.children?.[0];
  if (firstText?.type !== 'text' || typeof firstText.value !== 'string') return;
  const match = CALLOUT_MARKER.exec(firstText.value);
  if (!match) return;

  const kind = match[1]!.toLowerCase();
  const customTitle = match[2]!.trim();
  // Strip the marker line; when it was the paragraph's only content, drop the
  // now-empty paragraph so the callout does not open with a blank line.
  firstText.value = firstText.value.slice(match[0].length);
  if (!firstText.value && firstBlock.children.length === 1) blockquote.children.shift();

  const title = customTitle || kind.charAt(0).toUpperCase() + kind.slice(1);
  blockquote.children.unshift({
    type: 'paragraph',
    children: [{ type: 'text', value: title }],
    data: { hProperties: { className: 'kp-rv-callout-title' } },
  });
  blockquote.data = {
    ...(blockquote.data ?? {}),
    hProperties: {
      ...(blockquote.data?.hProperties ?? {}),
      className: `me-renderer-callout me-renderer-callout-${kind} kp-rv-callout`,
    },
  };
}

/** The fence language of a `<pre>`'s `<code>` child, if it declared one. */
function fenceLanguage(codeChild: any): string | undefined {
  const className: unknown = codeChild?.props?.className;
  if (typeof className !== 'string') return undefined;
  return /\blanguage-([\w+-]+)/.exec(className)?.[1]?.toLowerCase();
}

/**
 * A per-document-stable id for a fenced block, for mermaid's SVG element ids.
 * The source line is stable across re-renders of the same markdown, which keeps
 * React from remounting (and mermaid from re-rendering) on every keystroke in
 * Compose's live preview.
 */
function blockIdOf(node: any): string {
  const line = node?.position?.start?.line;
  return typeof line === 'number' ? `read-block-${line}` : 'read-block';
}

export const ReadView: React.FC<ReadViewProps> = ({ markdown, knownSlugs }) => {
  // Pre-process wiki-links once per markdown change.
  const processed = useMemo(() => wikiLinksToMarkdown(markdown), [markdown]);

  return (
    <div className="kp-read-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        components={{
          // Wiki-link styling: detect via title="wiki" attr.
          a: ({ node, href, title, children, ...props }) => {
            const isWiki = title === 'wiki';
            // Render-time resolution: a wiki-link to a slug that doesn't exist is
            // a "red link" (non-navigating), so missing targets are obvious
            // instead of silently 404-ing. Source content stays OKF-true.
            if (isWiki && knownSlugs) {
              const slug = (href ?? '').replace(/^\/p\//, '');
              if (!knownSlugs.has(slug)) {
                return (
                  <span
                    className="kp-rv-wikilink-missing"
                    title="No page with this title yet"
                    style={{ color: 'var(--danger, #cf222e)', borderBottom: '1px dashed currentColor', cursor: 'help' }}
                  >
                    {children}
                  </span>
                );
              }
            }
            // External links open in a new tab and must carry rel="noopener
            // noreferrer" so the opened page can't reach back via window.opener.
            const isExternal = !!href && /^(https?:)?\/\//i.test(href);
            return (
              <a
                href={href}
                title={undefined /* don't surface "wiki" in tooltip */}
                className={isWiki ? 'kp-rv-wikilink' : 'kp-rv-link'}
                {...props}
                {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {children}
              </a>
            );
          },
          // react-markdown v9 removed the `inline` prop, so a `code` override
          // must never emit a <pre> itself (that produced <pre> inside <p> for
          // inline code, an invalid-nesting bug). Inline code → <code>; fenced
          // blocks keep their `language-*` class and are handled by the `pre`
          // override below, which is where the block-level renderers attach.
          code: ({ className, children, ...props }: any) => {
            const isBlock = typeof className === 'string' && /\blanguage-/.test(className);
            return (
              <code className={isBlock ? className : 'kp-rv-inline-code'} {...props}>
                {children}
              </code>
            );
          },
          // Fenced blocks. A ```mermaid fence becomes a diagram and a
          // language-tagged fence becomes highlighted code, both through the
          // editor's own renderers, lazily (see ./richBlocks.tsx). An untagged
          // fence keeps the plain token-styled block and costs nothing — no
          // highlighter is loaded for it.
          pre: ({ node, children, ...props }: any) => {
            const codeChild = React.Children.toArray(children)[0];
            const language = fenceLanguage(codeChild);
            if (language) {
              const source = textOf((codeChild as any)?.props?.children).replace(/\n$/, '');
              const blockId = blockIdOf(node);
              if (language === 'mermaid') return <MermaidFigure source={source} blockId={blockId} />;
              return <HighlightedCode language={language} source={source} blockId={blockId} />;
            }
            return (
              <pre className="kp-rv-code-block" {...props}>
                {children}
              </pre>
            );
          },
          // Callouts (see remarkCallouts): a marked blockquote is an <aside>,
          // which is what it is semantically — an aside to the prose, not a
          // quotation. An ordinary blockquote is untouched.
          blockquote: ({ node, className, children, ...props }: any) => {
            if (typeof className === 'string' && className.includes('me-renderer-callout')) {
              return (
                <aside className={className} {...props}>
                  {children}
                </aside>
              );
            }
            return (
              <blockquote className={className} {...props}>
                {children}
              </blockquote>
            );
          },
          // The item title is the document's H1 (page chrome), so demote body
          // headings one level — otherwise concepts that use `#` for sections
          // (the OKF/llm-wiki convention) render several competing H1s.
          h1: ({ children, ...props }: any) => <h2 id={headingSlug(textOf(children))} {...props}>{children}</h2>,
          h2: ({ children, ...props }: any) => <h3 id={headingSlug(textOf(children))} {...props}>{children}</h3>,
          h3: ({ children, ...props }: any) => <h4 id={headingSlug(textOf(children))} {...props}>{children}</h4>,
          h4: ({ children, ...props }: any) => <h5 {...props}>{children}</h5>,
          h5: ({ children, ...props }: any) => <h6 {...props}>{children}</h6>,
          h6: ({ children, ...props }: any) => <h6 {...props}>{children}</h6>,
          // Images: constrain to the content width and lazy-load. `src` is a
          // bundle-relative `/assets/<file>` served by the API (proxied in dev).
          img: ({ node, ...props }: any) => (
            // `alt` is not set literally here: it arrives via {...props} from
            // the markdown image syntax (`![alt](src)`), so it is authored in
            // the source file rather than in this component.
            <img loading="lazy" style={{ maxWidth: '100%', height: 'auto', borderRadius: '6px' }} {...props} />
          ),
          // Tables: wrap in an overflow container so wide tables scroll
          // horizontally INSIDE the cell (not push the body wide).
          table: ({ children, ...props }) => (
            <div className="kp-rv-table-wrap">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
};
