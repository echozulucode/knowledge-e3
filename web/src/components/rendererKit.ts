/**
 * The heavy half of the shared renderers, isolated so the bundler can split it.
 *
 * THIS MODULE MUST ONLY EVER BE REACHED THROUGH `import()` (see richBlocks.tsx).
 * It is a separate file for one reason, measured rather than assumed: a dynamic
 * `import('@echozedlabs/renderers')` resolves to that package's index module,
 * which the editor already imports statically — so the bundler folds the whole
 * namespace (shiki's core engine included, ~190 kB raw) into the main chunk and
 * every page pays for it. Naming the two exports from a module that nothing
 * imports statically keeps `shiki/core` reachable only from the async chunk,
 * which is what makes "a page with no diagram and no code fence pays nothing"
 * true instead of aspirational.
 *
 * Both factories are cheap closures; the engines they need (`mermaid`,
 * `shiki/core`, plus shiki's per-language grammars) are `import()`ed inside the
 * package on first render.
 */
import { createMermaidRenderer, createShikiCodeRenderer } from '@echozedlabs/renderers';

export const mermaidRenderer = createMermaidRenderer();
export const shikiRenderer = createShikiCodeRenderer();
