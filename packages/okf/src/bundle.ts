import type { BuildOptions, BundleFile, BundleLink, OkfBundle, PageInput } from './types.js';
import { conceptPathForSlug, pageToConcept } from './concept.js';
import type { LinkResolver } from './links.js';

const DEFAULT_CONCEPT_DIR = 'concepts';

/**
 * Build a complete OKF bundle from a set of Knowledge E3 pages.
 *
 * Produces one concept file per page under `conceptDir/`, plus a bundle-root
 * `index.md` for progressive disclosure that declares the OKF version. Cross-links
 * are resolved across the whole page set so `[[Title]]` references become
 * bundle-relative links to the right concept.
 */
export function buildBundle(pages: PageInput[], opts: BuildOptions = {}): OkfBundle {
  const conceptDir = opts.conceptDir ?? DEFAULT_CONCEPT_DIR;

  // Resolve wiki-link targets by title (case-insensitive) to bundle-relative paths.
  const titleToPath = new Map<string, string>();
  for (const page of pages) {
    titleToPath.set(page.title.trim().toLowerCase(), `/${conceptPathForSlug(page.slug, conceptDir)}`);
  }
  const resolve: LinkResolver = (title) => titleToPath.get(title.trim().toLowerCase());

  const concepts = pages.map((page) => pageToConcept(page, resolve, opts));

  const files: BundleFile[] = concepts.map((c) => ({ path: c.path, content: c.content }));
  files.push({
    path: 'index.md',
    content: renderBundleIndex(
      concepts.map((c) => ({
        path: c.path,
        title: typeof c.frontmatter.title === 'string' ? c.frontmatter.title : c.conceptId,
        description:
          typeof c.frontmatter.description === 'string' ? c.frontmatter.description : undefined,
      })),
      opts,
    ),
  });

  return { files };
}

/** One concept's summary line for the bundle-root index. */
export interface BundleIndexEntry {
  /** Bundle-relative path, e.g. `concepts/my-page.md`. */
  path: string;
  title?: string;
  description?: string;
}

/**
 * Bundle-root `index.md` for progressive disclosure. Per OKF, the bundle root is
 * the only place index frontmatter is permitted: `okf_version` (always, first),
 * plus the topic's `presentation`, `start_here` and curated `links` when set.
 * Landing prose (`landingMarkdown`) renders between the title and `## Concepts`;
 * `parseBundleIndex` reads all of them back. Entries are listed in the order
 * given; callers that want a stable bundle should sort.
 */
export function renderBundleIndex(
  entries: BundleIndexEntry[],
  opts: Pick<BuildOptions, 'okfVersion' | 'bundleTitle' | 'bundleDescription' | 'presentation' | 'startHere' | 'landingMarkdown' | 'links'> = {},
): string {
  const version = opts.okfVersion ?? '0.2';
  const title = opts.bundleTitle ?? 'Knowledge Bundle';
  const description = opts.bundleDescription ?? 'Exported from Knowledge E3 in Open Knowledge Format.';

  const lines: string[] = [];
  lines.push('---');
  lines.push(`okf_version: "${version}"`);
  if (opts.presentation) lines.push(`presentation: ${opts.presentation}`);
  if (opts.startHere?.trim()) lines.push(`start_here: ${JSON.stringify(opts.startHere.trim())}`);
  lines.push(...linkLines(opts.links));
  lines.push('---');
  lines.push('');
  lines.push(`# ${title} Index`);
  lines.push('');
  lines.push(`> ${description}`);
  lines.push('');
  if (opts.landingMarkdown?.trim()) {
    lines.push(opts.landingMarkdown.trim());
    lines.push('');
  }
  lines.push('## Concepts');
  lines.push('');
  for (const e of entries) {
    const desc = e.description ? ` - ${e.description}` : '';
    const name = e.title ?? e.path.replace(/\.md$/, '');
    lines.push(`* [${name}](/${e.path})${desc}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * `links:` frontmatter for the curated landing-page links, emitted as a block
 * sequence of quoted scalars so a label containing `:` or `#` round-trips. Empty
 * when there is nothing curated, so an index that never had links is unchanged.
 */
function linkLines(links: BundleLink[] | undefined): string[] {
  const out: string[] = [];
  for (const link of links ?? []) {
    const label = link.label?.trim();
    const to = link.to?.trim();
    const href = link.href?.trim();
    // The same rule `parseBundleIndex` enforces on the way in: a label, and
    // exactly one destination.
    if (!label || (!to && !href) || (to && href)) continue;
    out.push(`  - label: ${JSON.stringify(label)}`);
    out.push(to ? `    to: ${JSON.stringify(to)}` : `    href: ${JSON.stringify(href)}`);
    const description = link.description?.trim();
    if (description) out.push(`    description: ${JSON.stringify(description)}`);
  }
  return out.length ? ['links:', ...out] : [];
}
