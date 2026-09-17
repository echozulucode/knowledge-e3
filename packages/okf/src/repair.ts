/**
 * Degrade-and-repair authoring robustness (inspired by openwiki).
 *
 * The principle: never hard-fail an agent/import edit over a broken link, a bad
 * diagram, or malformed content. Instead *degrade* it to something still readable
 * and stamp an inline repair marker (`<!-- e3-repair: … -->`) that a later pass
 * can find and fix — the same self-healing loop openwiki uses. A content-hash
 * no-op guard avoids rewriting (and re-committing) unchanged content.
 *
 * Pure and browser-safe: no crypto, no fs. The git-of-record mirror can layer a
 * real digest on top; {@link isContentUnchanged} covers the common case.
 */

/** Prefix identifying an inline repair marker. */
export const REPAIR_PREFIX = 'e3-repair:';

/** Build an inline repair marker HTML comment. */
export function repairMarker(reason: string): string {
  return `<!-- ${REPAIR_PREFIX} ${reason.replace(/--+/g, '—').trim()} -->`;
}

export interface RepairResult {
  body: string;
  /** Human-readable reasons for each repair applied. */
  repairs: string[];
}

const BUNDLE_LINK = /\[([^\]\n]+)\]\((\/[^)\n]+?\.md)([^)\n]*)\)/g;

/**
 * Mark bundle-relative concept links whose target is not in `existingPaths`. Broken
 * links are tolerated by OKF (§6.1) — they may be not-yet-written knowledge — so we
 * do not remove them; we append a repair marker so the gap is discoverable and a
 * later pass can create the target or fix the link. Paths are matched with and
 * without a leading slash. Idempotent: a link already followed by a marker is skipped.
 */
export function repairBrokenLinks(body: string, existingPaths: Iterable<string>): RepairResult {
  const exists = new Set<string>();
  for (const p of existingPaths) {
    exists.add(p.startsWith('/') ? p : `/${p}`);
  }
  const repairs: string[] = [];
  const out = body.replace(BUNDLE_LINK, (match, text: string, target: string, tail: string, offset: number, full: string) => {
    if (exists.has(target)) return match;
    // Idempotency: don't double-mark.
    const after = full.slice(offset + match.length, offset + match.length + 80);
    if (after.trimStart().startsWith(`<!-- ${REPAIR_PREFIX}`)) return match;
    repairs.push(`broken link to ${target}`);
    return `${match} ${repairMarker(`broken link to ${target}`)}`;
  });
  return { body: out, repairs };
}

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;

/**
 * Downgrade invalid Mermaid diagrams to a plain code fence plus a repair marker, so
 * a broken diagram renders as readable text instead of a render error. `validate`
 * returns true for a diagram that should be left as-is.
 */
export function downgradeInvalidMermaid(
  body: string,
  validate: (code: string) => boolean,
): RepairResult {
  const repairs: string[] = [];
  const out = body.replace(MERMAID_FENCE, (match, code: string) => {
    if (validate(code)) return match;
    repairs.push('invalid mermaid diagram downgraded to a text block');
    return `${repairMarker('invalid mermaid diagram — fix and restore the ```mermaid fence')}\n\n\`\`\`text\n${code}\`\`\``;
  });
  return { body: out, repairs };
}

/** Every repair-marker reason currently present in a body. */
export function extractRepairMarkers(body: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<!--\\s*${REPAIR_PREFIX}\\s*([\\s\\S]*?)-->`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]!.trim());
  return out;
}

/** Remove all repair markers (e.g. once the underlying issues are fixed). */
export function stripRepairMarkers(body: string): string {
  return body
    .replace(new RegExp(`[ \\t]*<!--\\s*${REPAIR_PREFIX}[\\s\\S]*?-->`, 'g'), '')
    .replace(/[ \t]+$/gm, '');
}

/**
 * Content-hash no-op guard. Returns true when `next` is materially identical to
 * `prev` (ignoring trailing whitespace and final-newline differences), so a writer
 * can skip an unchanged write — and, for the git mirror, avoid an empty commit.
 */
export function isContentUnchanged(prev: string | undefined, next: string): boolean {
  if (prev === undefined) return false;
  return normalize(prev) === normalize(next);
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}
