import { parse, extractWikiLinks, extractItemLinks } from '@echozedlabs/codec';
import { classifyPathValue } from './attested.js';
import type { BundleLinkIssue, LinkStyle, OkfBundle } from './types.js';

/**
 * Resolves a wiki-link target title to a bundle-relative path (e.g.
 * `/concepts/my-page.md`), or `undefined` when the target is not in the bundle.
 */
export type LinkResolver = (title: string) => string | undefined;

/**
 * Translate `[[wiki-links]]` in an E3 document body into OKF-friendly links.
 *
 * Operates on the parsed body (so frontmatter is excluded) and uses the codec's
 * AST-aware `extractWikiLinks`, which already ignores wiki-link syntax inside
 * fenced/inline code and image alt text. Unresolved targets are left untouched —
 * OKF consumers tolerate broken links (spec §5.3).
 *
 * Note: the E3 codec recognizes only `[[Title]]` (no `[[Title|alias]]`) in v0.1.
 */
export function translateLinks(
  rawMarkdown: string,
  resolve: LinkResolver,
  style: LinkStyle = 'dual',
): string {
  const parsed = parse(rawMarkdown);
  if (style === 'preserve') return parsed.body;

  let body = parsed.body;
  const occurrences = extractWikiLinks(parsed);

  // Splice from the back so earlier byte offsets stay valid as we mutate.
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const occ = occurrences[i];
    if (!occ) continue;
    const target = resolve(occ.target);
    if (!target) continue; // unresolved → leave the original token in place
    const markdownLink = `[${occ.target}](${target})`;
    const replacement = style === 'markdown' ? markdownLink : `${occ.raw} (${markdownLink})`;
    body = body.slice(0, occ.start) + replacement + body.slice(occ.end);
  }

  return body;
}

/** Filenames reserved by OKF — generated, never authored, so never link-checked. */
const RESERVED = new Set(['index.md', 'log.md']);

/**
 * The set of things a link inside a bundle can legitimately point at.
 *
 * Three indexes because the bundle carries three link *forms*, all of which are
 * produced by this library and therefore all of which have to be checkable:
 *  - `[[Title]]` wiki-links, which {@link buildBundle} resolves by frontmatter
 *    `title` (case-insensitively), so that is the index they are checked against;
 *  - bundle-relative markdown links (`/concepts/orders.md`), the form
 *    `linkStyle: 'markdown' | 'dual'` emits and a pure-OKF producer writes;
 *  - bundle-relative *path-valued frontmatter* (§6.2) — `computation`,
 *    `executor.resource`, `attester.resource`, `sources[].resource`.
 *
 * There is no `relations:` family in OKF v0.2 and none in E3's frontmatter, so
 * "relation targets" are exactly these path-valued fields plus the body links.
 */
interface BundleLinkIndex {
  /** Every file and asset path in the bundle, normalized to a leading `/`. */
  paths: Set<string>;
  /** Lowercased frontmatter `title` of every concept. */
  titles: Set<string>;
  /** Concept filename stems, plus the slugified form of each title. */
  slugs: Set<string>;
}

function indexBundleTargets(bundle: OkfBundle): BundleLinkIndex {
  const index: BundleLinkIndex = { paths: new Set(), titles: new Set(), slugs: new Set() };
  for (const file of bundle.files) index.paths.add(normalizePath(file.path));
  for (const asset of bundle.assets ?? []) index.paths.add(normalizePath(asset.path));

  for (const file of conceptFiles(bundle)) {
    const stem = basename(file.path).replace(/\.md$/, '');
    index.slugs.add(stem.toLowerCase());
    const title = (parse(file.content).frontmatter as Record<string, unknown> | undefined)?.['title'];
    if (typeof title === 'string' && title.trim() !== '') {
      index.titles.add(title.trim().toLowerCase());
      index.slugs.add(slugifyTitle(title));
    }
  }
  return index;
}

/**
 * Resolve every cross-reference in a bundle against the bundle itself and report
 * the ones that dangle. Every finding is a `warning` — see {@link BundleLinkIssue}
 * for why an unresolved link is never grounds for rejecting a bundle.
 *
 * Only *bundle-relative* (`/…`) path links are checked: an absolute URL is out of
 * our reach and a relative path (`./x`, `../x`) is resolved against a location the
 * bundle does not define, so neither can be called broken from here (§6.2).
 * Reserved files are skipped, exactly as they are in the conformance check.
 */
export function resolveBundleLinks(bundle: OkfBundle): BundleLinkIssue[] {
  const index = indexBundleTargets(bundle);
  const issues: BundleLinkIssue[] = [];

  for (const file of conceptFiles(bundle)) {
    const parsed = parse(file.content);
    // One finding per distinct target per file: a concept that links the same
    // missing page five times has one problem, not five.
    const seen = new Set<string>();

    for (const link of extractItemLinks(parsed)) {
      if (link.type === 'wiki') {
        if (!firstSighting(seen, `w:${link.target.trim().toLowerCase()}`)) continue;
        if (resolvesByTitle(index, link.target)) continue;
        issues.push({
          path: file.path,
          code: 'link.unresolved',
          severity: 'warning',
          origin: 'wiki-link',
          target: link.target,
          message: `Wiki link [[${link.target}]] does not resolve to a concept in this bundle.`,
        });
        continue;
      }
      if (!link.target.startsWith('/')) continue; // external or relative → unknowable here
      const target = normalizePath(link.target);
      if (!firstSighting(seen, `p:${target}`)) continue;
      if (index.paths.has(target)) continue;
      issues.push({
        path: file.path,
        code: 'link.unresolved',
        severity: 'warning',
        origin: 'markdown-link',
        target: link.target,
        message: `Link target \`${link.target}\` is not in this bundle.`,
      });
    }

    const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
    for (const [field, value] of pathValuedFields(fm)) {
      if (classifyPathValue(value) !== 'bundle-relative') continue;
      const target = normalizePath(value);
      if (!firstSighting(seen, `f:${field}:${target}`)) continue;
      if (index.paths.has(target)) continue;
      issues.push({
        path: file.path,
        code: 'link.unresolved',
        severity: 'warning',
        origin: 'frontmatter',
        field,
        target: value,
        message: `\`${field}\` points at \`${value}\`, which is not in this bundle (§6.2).`,
      });
    }
  }

  return issues;
}

/** True the first time `key` is offered, false on every repeat. */
function firstSighting(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** Concept documents: `.md`, minus the reserved generated files. */
function conceptFiles(bundle: OkfBundle) {
  return bundle.files.filter((f) => f.path.endsWith('.md') && !RESERVED.has(basename(f.path)));
}

/**
 * A wiki-link resolves on the title index first (what the exporter writes), and
 * falls back to the slug index so a `[[Title]]` written against a concept's
 * filename still resolves — the same two-step the content-model lint uses.
 */
function resolvesByTitle(index: BundleLinkIndex, target: string): boolean {
  const t = target.trim().toLowerCase();
  return index.titles.has(t) || index.slugs.has(t) || index.slugs.has(slugifyTitle(target));
}

/** The §6.2 path-valued frontmatter keys, flattened to `[dotted key, value]`. */
function pathValuedFields(fm: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const push = (field: string, value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') out.push([field, value.trim()]);
  };
  push('computation', fm['computation']);
  push('executor.resource', asRecord(fm['executor'])?.['resource']);
  push('attester.resource', asRecord(fm['attester'])?.['resource']);
  if (Array.isArray(fm['sources'])) {
    (fm['sources'] as unknown[]).forEach((entry, i) => {
      push(`sources[${i}].resource`, asRecord(entry)?.['resource']);
    });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Compare paths in one shape: leading `/`, no `#fragment` or `?query`, and
 * percent-escapes decoded so `/concepts/my%20page.md` matches the file on disk.
 */
function normalizePath(path: string): string {
  let p = path.trim().split('#')[0]!.split('?')[0]!;
  try {
    p = decodeURIComponent(p);
  } catch {
    // A malformed escape is not a path we can normalize; compare it verbatim.
  }
  return p.startsWith('/') ? p : `/${p}`;
}

/** Same derivation as the server's `slugify`, so `[[Title]]` can be matched to a filename. */
function slugifyTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}
