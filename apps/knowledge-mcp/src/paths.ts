/**
 * Path safety for local sources. Only configured roots are readable:
 *
 *  - a root is resolved to its REAL path once (a root that is itself a symlink
 *    is fine — it is what the user configured);
 *  - the walk never follows a symbolic link or junction inside the root, and
 *    every file it reads is re-checked by real path to lie inside the root, so
 *    neither a link nor a `..` segment can reach outside it;
 *  - dot-directories (`.git`, `.e3`, editor state), `assets/` and `node_modules/`
 *    are never walked.
 *
 * Nothing here takes a path from a tool argument: items are found through the
 * in-memory index by id, slug or title, never by a caller-supplied file path.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const SKIPPED_DIRS = new Set(['assets', 'node_modules']);
/** Larger Markdown files are skipped with a warning: a knowledge item is not a data dump. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

/** The real path of a configured root; it must be a directory. */
export function realRoot(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new PathSafetyError(`source path does not exist: ${path}`);
  }
  if (!statSync(real).isDirectory()) throw new PathSafetyError(`source path is not a directory: ${path}`);
  return real;
}

/** True when `candidate` (an absolute path) is `root` or lies beneath it. */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/**
 * Resolve a root-relative posix path to a real file path inside `root`, or
 * `null` when it escapes (by `..`, an absolute path, or a link) or is not a
 * regular file.
 */
export function safeFile(root: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) return null;
  const abs = join(root, relPath);
  if (!isInside(root, abs)) return null;
  try {
    const link = lstatSync(abs);
    if (link.isSymbolicLink() || !link.isFile()) return null;
    const real = realpathSync.native(abs);
    return isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

export interface WalkResult {
  /** Root-relative posix paths of regular files. */
  files: string[];
  /** Root-relative posix paths of links that were not followed. */
  skippedLinks: string[];
}

/** Every regular file under `root`, never following links, skipping machinery directories. */
export function walkFiles(root: string): WalkResult {
  const files: string[] = [];
  const skippedLinks: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        skippedLinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
        // A junction on Windows can report as a directory through readdir: check lstat too.
        try {
          if (lstatSync(abs).isSymbolicLink() || !isInside(root, realpathSync.native(abs))) {
            skippedLinks.push(rel);
            continue;
          }
        } catch {
          continue;
        }
        visit(abs);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  visit(root);
  files.sort();
  return { files, skippedLinks };
}
