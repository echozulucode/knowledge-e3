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
 */

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

/** Slug for a heading — must match the TOC slugging in PageView. */
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

export const ReadView: React.FC<ReadViewProps> = ({ markdown, knownSlugs }) => {
  // Pre-process wiki-links once per markdown change.
  const processed = useMemo(() => wikiLinksToMarkdown(markdown), [markdown]);

  return (
    <div className="kp-read-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
          // blocks keep their `language-*` class and get block styling from the
          // `pre` override below.
          code: ({ className, children, ...props }: any) => {
            const isBlock = typeof className === 'string' && /\blanguage-/.test(className);
            return (
              <code className={isBlock ? className : 'kp-rv-inline-code'} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...props }: any) => (
            <pre className="kp-rv-code-block" {...props}>
              {children}
            </pre>
          ),
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
            // eslint-disable-next-line jsx-a11y/alt-text
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
