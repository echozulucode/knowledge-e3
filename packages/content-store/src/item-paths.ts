/**
 * Which files of a bundle root are *items* (plan §8.3, "import an existing
 * repository of Markdown").
 *
 * Two callers need exactly one answer to that question and must never drift:
 *
 *  - the **inbound indexer** (server/src/sync/inbound-index.service.ts), which
 *    asks it of each path a fetch/merge changed, and
 *  - the **rebuild** (server/src/storage/index-rebuild.service.ts), which asks
 *    it of every file `LocalBundleStore.list()` walks.
 *
 * Before this module the rule lived only in the sync service while `list()`
 * enumerated the canonical layout alone, so a glob-matched import was indexed
 * on sync and then *lost* by a drop-and-rebuild (issue 94). The rule — and the
 * glob matcher under it — lives here, in the package both paths already depend
 * on, and each caller adapts its own configuration into `ItemSelection`.
 */
import { toPosix } from './paths.js';

const ASSETS_DIR = 'assets';
const DEFAULT_RESERVED = ['index.md', 'log.md'];
const DEFAULT_CONCEPT_DIR = 'concepts';

/**
 * A source's glob configuration (`content_sources.include_globs` /
 * `exclude_globs`), already decoded into lists. An empty/absent `include` means
 * "the canonical `concepts/` layout" — the behaviour that predates globs.
 */
export interface ItemSelection {
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface ItemPathOptions {
  /** Concept directory name; default `concepts`. */
  conceptDir?: string;
  /** Basenames that are never items; default `index.md`, `log.md`. */
  reserved?: readonly string[];
}

/** `concepts/x.md` or `<any>/concepts/x.md`, not a reserved basename. */
export function isConceptPath(path: string, opts: ItemPathOptions = {}): boolean {
  const p = toPosix(path);
  if (!p.endsWith('.md')) return false;
  if (isReserved(p, opts)) return false;
  const dir = (opts.conceptDir ?? DEFAULT_CONCEPT_DIR).replace(/^\/+|\/+$/g, '');
  const cut = p.lastIndexOf('/');
  const parent = cut < 0 ? '' : p.slice(0, cut);
  return parent === dir || parent.endsWith(`/${dir}`);
}

/**
 * Whether a bundle with this selection indexes this file.
 *
 * With no `include` globs the answer is exactly what it has always been: the
 * canonical concept layout. With globs it is the `.md` files they select, minus
 * `exclude`. Reserved basenames (`index.md`, `log.md`) and anything under an
 * `assets/` directory are never items, whatever the globs say.
 */
export function isIndexablePath(path: string, selection: ItemSelection = {}, opts: ItemPathOptions = {}): boolean {
  const p = toPosix(path);
  if (isReserved(p, opts)) return false;
  if (isAssetPath(p)) return false;
  const include = selection.include ?? [];
  if (include.length === 0) return isConceptPath(p, opts);
  if (!p.toLowerCase().endsWith('.md')) return false;
  if (!include.some((g) => matchesGlob(p, g))) return false;
  return !(selection.exclude ?? []).some((g) => matchesGlob(p, g));
}

/** An indexed file that is *not* in the canonical layout — i.e. one the globs brought in. */
export function isImportedPath(path: string, selection: ItemSelection = {}, opts: ItemPathOptions = {}): boolean {
  return isIndexablePath(path, selection, opts) && !isConceptPath(path, opts);
}

function isReserved(path: string, opts: ItemPathOptions): boolean {
  const reserved = opts.reserved ?? DEFAULT_RESERVED;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return reserved.includes(base);
}

/** Any `assets/` directory at any depth, as `LocalBundleStore.list` skips them. */
function isAssetPath(path: string): boolean {
  return path.split('/').slice(0, -1).includes(ASSETS_DIR);
}

const globCache = new Map<string, RegExp>();

/**
 * One repo-relative posix glob, matched against one repo-relative posix path.
 *
 * Hand-rolled on purpose: the monorepo has no glob matcher among its
 * dependencies and this needs three constructs, not a library —
 *   `*`  any run of characters inside one segment,
 *   `?`  one character inside one segment,
 *   `**` whole segments: `a/**` + `/b` matches `a/b` and `a/x/y/b`, and a
 *        leading `**` + `/` matches at the root too (so `**` + `/concepts/*.md`
 *        is exactly the default rule).
 * Brace and bracket expressions are not supported; a pattern with no `/`
 * matches at the repository root only, as it would anywhere else.
 */
export function matchesGlob(path: string, glob: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(toPosix(path));
}

function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        if (g[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]+/)*'; // whole segments, including none
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}
