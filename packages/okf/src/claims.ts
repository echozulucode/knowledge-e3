/**
 * Claim-health scoring (inspired by openwiki's LEDGER eval).
 *
 * Extracts atomic factual claims from a concept body and grades each against the
 * concept's provenance: **supported** (backed by a cited source), **stale**
 * (supported but past `stale_after`), **hallucinated** (contradicted by grounding),
 * or **unverified** (no citation / cannot determine). The aggregate is a "claim
 * health" score — the fraction of claims that are supported.
 *
 * This module is pure and browser-safe. The deterministic baseline grades on
 * *citation presence* only: it can tell cited from uncited but cannot, on its own,
 * detect a hallucination (that needs source content). Supply a {@link ClaimGrounding}
 * (e.g. an LLM- or fetch-backed one, run server-side) to upgrade grading to real
 * source-grounding — the extension point openwiki's LEDGER fills.
 */
import { parse } from '@echozedlabs/codec';
import { normalizeVerified } from './trust.js';
import { isStale } from './lifecycle.js';

export type ClaimStatus = 'supported' | 'stale' | 'hallucinated' | 'unverified';

export interface Claim {
  /** The claim sentence, footnote markers stripped. */
  text: string;
  /** `sources[].id`s cited by this claim via `[^id]` footnotes. */
  citedSourceIds: string[];
}

/**
 * Pluggable grounding. Returns whether a claim is supported by its cited sources.
 * `unknown` means "cannot determine" (the deterministic baseline's answer for an
 * uncited claim). Implementations that read source content can return
 * `hallucinated` when a claim is contradicted.
 */
export interface ClaimGrounding {
  ground(claim: Claim, sourceIds: ReadonlySet<string>): 'supported' | 'hallucinated' | 'unknown';
}

/** The default grounding: cited ⇒ supported, uncited ⇒ unknown. Never hallucinated. */
export const citationGrounding: ClaimGrounding = {
  ground(claim, sourceIds) {
    return claim.citedSourceIds.some((id) => sourceIds.has(id)) ? 'supported' : 'unknown';
  },
};

export interface ClaimHealth {
  total: number;
  supported: number;
  stale: number;
  hallucinated: number;
  unverified: number;
  /** Supported ÷ total, in [0, 1]. 1 when there are no claims. */
  score: number;
  claims: { claim: Claim; status: ClaimStatus }[];
}

const FOOTNOTE_REF = /\[\^([^\]]+)\]/g;

/**
 * Extract candidate atomic claims from a markdown body: prose sentences outside
 * headings, code fences, tables, and list markers. Footnote markers are recorded
 * then stripped from the claim text.
 */
export function extractClaims(body: string): Claim[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, '').replace(/^ {4}.*$/gm, '');
  const claims: Claim[] = [];
  for (const rawLine of withoutCode.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // headings
    if (line.startsWith('|')) continue; // table rows
    if (line.startsWith('[^')) continue; // footnote definitions
    if (/^[-*>]\s/.test(line)) continue; // list / quote markers (keep it simple)
    // Split into sentences on end punctuation followed by space/end.
    for (const piece of line.split(/(?<=[.!?])\s+/)) {
      const sentence = piece.trim();
      if (sentence.replace(FOOTNOTE_REF, '').trim().length < 20) continue; // skip fragments
      const citedSourceIds: string[] = [];
      let m: RegExpExecArray | null;
      FOOTNOTE_REF.lastIndex = 0;
      while ((m = FOOTNOTE_REF.exec(sentence)) !== null) citedSourceIds.push(m[1]!);
      claims.push({ text: sentence.replace(FOOTNOTE_REF, '').trim(), citedSourceIds });
    }
  }
  return claims;
}

/** The `sources[].id`s declared in a concept's frontmatter. */
export function sourceIdsOf(fm: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const sources = fm['sources'];
  if (Array.isArray(sources)) {
    for (const s of sources) {
      if (s && typeof s === 'object' && typeof (s as Record<string, unknown>)['id'] === 'string') {
        out.add((s as Record<string, unknown>)['id'] as string);
      }
    }
  }
  return out;
}

export interface ClaimHealthOptions {
  grounding?: ClaimGrounding;
  /** Date to evaluate `stale_after` against. Defaults to the current date. */
  asOf?: string | Date;
}

/**
 * Score the claim health of a full concept document (frontmatter + body). A
 * supported claim in a stale concept is reported as `stale`; an uncited claim is
 * `unverified`; `hallucinated` only arises from a grounding that reads sources.
 */
export function scoreClaimHealth(content: string, opts: ClaimHealthOptions = {}): ClaimHealth {
  const parsed = parse(content);
  const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
  const grounding = opts.grounding ?? citationGrounding;
  const sourceIds = sourceIdsOf(fm);
  const stale = isStale(fm['stale_after'], opts.asOf);
  // A concept with no verification anywhere caps supported claims — provenance of
  // authorship without confirmation is weaker, but we still credit citations.
  void normalizeVerified(fm['verified']);

  const claims = extractClaims(parsed.body);
  const graded: { claim: Claim; status: ClaimStatus }[] = [];
  let supported = 0,
    staleN = 0,
    hallucinated = 0,
    unverified = 0;

  for (const claim of claims) {
    const verdict = grounding.ground(claim, sourceIds);
    let status: ClaimStatus;
    if (verdict === 'hallucinated') {
      status = 'hallucinated';
      hallucinated++;
    } else if (verdict === 'supported') {
      status = stale ? 'stale' : 'supported';
      if (stale) staleN++;
      else supported++;
    } else {
      status = 'unverified';
      unverified++;
    }
    graded.push({ claim, status });
  }

  const total = claims.length;
  return {
    total,
    supported,
    stale: staleN,
    hallucinated,
    unverified,
    score: total === 0 ? 1 : supported / total,
    claims: graded,
  };
}
