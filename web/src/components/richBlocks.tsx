/**
 * Rich block renderers for the READ surface — diagrams and syntax highlighting.
 *
 * These are the *same* renderers the editor's Preview/Hybrid modes use
 * (`@echozedlabs/renderers` → `createMermaidRenderer`, `createShikiCodeRenderer`),
 * so a diagram the author drew renders identically for every reader instead of
 * degrading to a grey code fence (reader UX plan §1.2, R1.1). ReadView keeps
 * react-markdown + remark-gfm for prose structure — see the note at the top of
 * ReadView.tsx for why — and delegates only the two block kinds react-markdown
 * cannot render at all.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. COST. The renderers (and through them mermaid and shiki, ~900 kB raw of
 *    async chunks) are reached ONLY through the `import('./rendererKit.js')`
 *    below, which only runs when a page actually contains a mermaid fence or a
 *    language-tagged code fence. A page with neither loads not one extra byte:
 *    the read path stays react-markdown + remark-gfm exactly as before.
 * 2. FAILURE. A malformed diagram must degrade to the fence it came from with
 *    the source still readable. Every path here — import failure, renderer
 *    failure, mermaid parse error, render timeout — resolves to `null`, and the
 *    caller then renders the plain fence. Nothing throws at the reader, and no
 *    error text replaces their content.
 * 3. SAFETY. Only two strings are ever injected as HTML, and each is sanitized
 *    at its source rather than trusted:
 *      - Mermaid SVG. `createMermaidRenderer` initializes mermaid with
 *        `securityLevel: 'strict'`, and mermaid runs its own DOMPurify pass over
 *        the generated SVG on any level but `loose` (mermaid.core: `svgCode =
 *        DOMPurify.sanitize(svgCode, …)`). It also sets `htmlLabels: false`, so
 *        no `<foreignObject>` HTML is produced in the first place. The diagram
 *        SOURCE is markdown text, never author HTML.
 *      - Shiki HTML. `codeToHtml` escapes every token's text content; the
 *        structure is shiki's own `<pre><code><span style=…>`. There is no path
 *        from fence content into an attribute or a tag name.
 *    Everything else on the read page (callouts included) is rendered as React
 *    elements, so react-markdown's default "no raw HTML" posture is unchanged:
 *    this adds no `rehype-raw`, no `dangerouslySetInnerHTML` over content, and
 *    therefore no new injection path for a mirrored `role: 'reference'`
 *    repository whose markdown somebody else controls.
 */

import { useEffect, useState } from 'react';
import type { CodeRendererOptions, DiagramRendererOptions, RendererResult } from '@echozedlabs/renderers';

/**
 * One dynamic import for the whole document, memoised so a page with twenty
 * code blocks loads the renderers once. The import target is ./rendererKit,
 * never `@echozedlabs/renderers` directly — see that file for why the extra hop
 * is what keeps the engines out of the main bundle. Rejections are not cached
 * as failures; the blocks simply keep their plain-fence fallback.
 */
let kit: Promise<typeof import('./rendererKit.js')> | undefined;

function loadRendererKit(): Promise<typeof import('./rendererKit.js')> {
  kit ??= import('./rendererKit.js');
  return kit;
}

/**
 * Render a mermaid fence, or resolve to `null` when it cannot be drawn.
 *
 * Also the editor's mermaid renderer (ItemEditorHost passes it to the preview
 * registry), so Preview and the read page share one loaded engine, one cached
 * initialization, and one bundle chunk.
 */
export async function renderMermaidDiagram(options: DiagramRendererOptions): Promise<RendererResult> {
  const { mermaidRenderer } = await loadRendererKit();
  return mermaidRenderer(options);
}

/** Highlight a code fence. Also the editor preview's code renderer. */
export async function renderHighlightedCode(options: CodeRendererOptions): Promise<RendererResult> {
  const { shikiRenderer } = await loadRendererKit();
  return shikiRenderer(options);
}

/**
 * Run a renderer, or resolve to `null` so the caller can fall back to the
 * source fence. `ok: false` is the renderers' own "here is an error
 * placeholder" result — we deliberately drop that placeholder and keep the
 * reader's original content instead.
 */
async function renderOrNull(run: () => Promise<RendererResult>): Promise<string | null> {
  try {
    const result = await run();
    return result.ok ? result.html : null;
  } catch {
    return null;
  }
}

/** The fence a block falls back to: the same markup a plain code block gets. */
function SourceFence({ language, source }: { language?: string; source: string }) {
  return (
    <pre className="kp-rv-code-block" data-language={language}>
      <code className={language ? `language-${language}` : undefined}>{source}</code>
    </pre>
  );
}

export interface RichBlockProps {
  /** Fence body, exactly as authored. */
  source: string;
  /** Stable per-document id, used by mermaid for its SVG element ids. */
  blockId: string;
}

/**
 * A ```mermaid fence. Renders the source fence until (and unless) mermaid
 * returns a diagram, so the reader can always read what the author wrote —
 * including while the ~600 kB mermaid chunk is still in flight and forever
 * after if the diagram does not parse.
 */
export function MermaidFigure({ source, blockId }: RichBlockProps) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    void (async () => {
      const html = await renderOrNull(() => renderMermaidDiagram({ source, blockId }));
      if (!cancelled && html) setSvg(html);
    })();
    return () => {
      cancelled = true;
    };
  }, [source, blockId]);

  if (!svg) return <SourceFence language="mermaid" source={source} />;
  // Sanitized inside mermaid (securityLevel: 'strict') — see the module header.
  return <div className="kp-rv-figure" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export interface HighlightedCodeProps extends RichBlockProps {
  /** Fence info string, e.g. `ts`. Absent-language fences never reach here. */
  language: string;
}

/**
 * A language-tagged code fence, highlighted by the shared shiki renderer.
 * Unknown languages are shiki's problem, not ours: it falls back to plaintext
 * highlighting and still returns `ok`, so the block keeps its house styling.
 */
export function HighlightedCode({ language, source, blockId }: HighlightedCodeProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void (async () => {
      const rendered = await renderOrNull(() => renderHighlightedCode({ language, source, blockId }));
      if (!cancelled && rendered) setHtml(rendered);
    })();
    return () => {
      cancelled = true;
    };
  }, [language, source, blockId]);

  if (!html) return <SourceFence language={language} source={source} />;
  // Escaped inside shiki's codeToHtml — see the module header.
  return <div className="kp-rv-highlight" dangerouslySetInnerHTML={{ __html: html }} />;
}
