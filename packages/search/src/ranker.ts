/**
 * Search ranker for backend textual relevance.
 *
 * SEARCH-002 swaps raw BM25-only ranking for transparent weighted scoring where
 * title signals outrank body-only matches and taxonomy matches participate with
 * explicit weights.
 */
import { parseSearchQuery } from './query-parser.js';

export interface PageCandidate {
  /** Internal page id. */
  id: string;
  /** Slug. */
  slug: string;
  /** Display title. */
  title: string;
  /** When the page was last updated, ISO. */
  updated_at: string;
  /** Raw match score from the dialect-specific FTS. Higher is better. */
  fts_rank: number;
  /** Optional snippet text from FTS. */
  snippet?: string;

  /** Optional metadata for weighted matching. */
  topic?: string;
  tags?: string[];
  categories?: string[];
  groups?: string[];
  body?: string;
  /** The item's one-line summary (frontmatter `description`), indexed since §5.4. */
  description?: string;
}

export interface RankedResult extends PageCandidate {
  score: number;
}

export interface Ranker {
  readonly name: string;
  score(query: string, candidates: PageCandidate[]): RankedResult[];
}

/**
 * The weighted model, highest signal first. `description` sits between the
 * title and the body in both its phrase and its token weight (reader UX plan
 * §5.4): it is the author's own one-line answer about the item, so a term there
 * is deliberate in a way the same term three paragraphs into the body is not —
 * but it is still prose about the item, not the item's name, so it stays below
 * the title and below the curated tag vocabulary. The phrase/token gap (65/50)
 * is the title's gap (90/75), applied one rung down.
 */
const TEXT_WEIGHTS = {
  exactTitleMatch: 100,
  phraseTitleMatch: 90,
  titleTokenMatch: 75,
  tagMatch: 70,
  phraseDescriptionMatch: 65,
  phraseBodyMatch: 60,
  topicMatch: 55,
  descriptionTokenMatch: 50,
  categoryMatch: 45,
  groupMatch: 45,
  bodyTokenMatch: 35,
  allTermsMatch: 12,
};

/**
 * The identifier / acronym boost (reader UX plan §5.3), the one place its
 * weight lives. When a query term that `isIdentifierLike` matches the title as
 * whole tokens, the title signal above is multiplied by this; when it matches a
 * tag, the tag signal is. Body, description and taxonomy signals are not.
 *
 * Why a multiplier on title/tag and not a flat bonus: this corpus is tool names,
 * error strings and part numbers. `MQTT` in a title means the page is ABOUT
 * MQTT; `MQTT` three times in the prose of a page about gateways means it is
 * used there. An ordinary word like `setup` in a title says much less, so the
 * title/tag-over-body margin widens only for identifiers. At 1.5, a one-word
 * query hitting title and tag (100 + 70) scores 255, which outweighs a page whose
 * description, body, topic and category all mention the term
 * (50 + 35 + 55 + 45 = 185) — and without the boost it would not (170 < 185).
 */
export const IDENTIFIER_MATCH_MULTIPLIER = 1.5;

/**
 * Weighted ranker used by SEARCH-002.
 *
 * Raw FTS score is still used as a fallback proxy for lexical relevance, but the
 * final score is now primarily a transparent weighted model across title, body,
 * and taxonomy fields.
 */
export class FtsRecencyRanker implements Ranker {
  readonly name = 'weighted-fts-recency';

  constructor(
    private readonly halfLifeDays = 365,
    private readonly recencyBoost = 6,
  ) {}

  score(query: string, candidates: PageCandidate[]): RankedResult[] {
    const parsed = parseSearchQuery(query);
    const baseTerms = parsed.terms.map(normalize).filter(Boolean);
    const basePhrases = parsed.phrases.map(normalize).filter(Boolean);
    const hasSearchSignal = baseTerms.length > 0 || basePhrases.length > 0;

    if (!hasSearchSignal) return [];

    const phraseBonus = parsed.phrases.length > 0 ? basePhrases : [];
    const fullQuery = normalize(parsed.raw);
    // Identifiers are classified on the query AS TYPED: `MQTT` is an acronym,
    // `mqtt` is not distinguishable from a word, and lowercasing first would
    // throw that signal away. Matching is then on whole tokens.
    const identifiers = [...parsed.terms, ...parsed.phrases].filter(isIdentifierLike).map(tokenize).filter((t) => t.length > 0);

    return candidates
      .map((candidate) => {
        const title = normalize(candidate.title);
        const body = normalize(candidate.body ?? '');
        const description = normalize(candidate.description ?? '');
        const topic = normalize(candidate.topic ?? '');
        const tags = (candidate.tags ?? []).map(normalize);
        const categories = (candidate.categories ?? []).map(normalize);
        const groups = (candidate.groups ?? []).map(normalize);

        let score = candidate.fts_rank;

        let titleSignal = 0;
        if (containsText(title, fullQuery)) {
          titleSignal = TEXT_WEIGHTS.exactTitleMatch;
        } else if (containsAnyPhrase(title, phraseBonus)) {
          titleSignal = TEXT_WEIGHTS.phraseTitleMatch;
        } else if (containsAnyTerm(title, baseTerms)) {
          titleSignal = TEXT_WEIGHTS.titleTokenMatch;
        }
        // An identifier matching as whole tokens is a title hit even when the
        // substring checks above missed it — `modbus_rtu` is the token sequence
        // `modbus rtu`, which is how FTS5 matched "Modbus RTU framing" at all.
        const identifierInTitle = identifiers.some((sequence) => containsTokenSequence(tokenize(title), sequence));
        if (identifierInTitle) titleSignal = Math.max(titleSignal, TEXT_WEIGHTS.titleTokenMatch) * IDENTIFIER_MATCH_MULTIPLIER;
        score += titleSignal;

        const identifierInTag = identifiers.some((sequence) => tags.some((tag) => containsTokenSequence(tokenize(tag), sequence)));
        if (identifierInTag) {
          score += TEXT_WEIGHTS.tagMatch * IDENTIFIER_MATCH_MULTIPLIER;
        } else if (containsAnyTermOrPhraseInList(tags, baseTerms, phraseBonus)) {
          score += TEXT_WEIGHTS.tagMatch;
        }
        if (containsAnyPhrase(description, phraseBonus)) {
          score += TEXT_WEIGHTS.phraseDescriptionMatch;
        }
        if (containsAnyPhrase(body, phraseBonus)) {
          score += TEXT_WEIGHTS.phraseBodyMatch;
        }
        if (containsAnyTermOrPhrase(topic, baseTerms, phraseBonus)) {
          score += TEXT_WEIGHTS.topicMatch;
        }
        if (containsAnyTermOrPhraseInList(categories, baseTerms, phraseBonus)) {
          score += TEXT_WEIGHTS.categoryMatch;
        }
        if (containsAnyTermOrPhraseInList(groups, baseTerms, phraseBonus)) {
          score += TEXT_WEIGHTS.groupMatch;
        }
        if (containsAnyTerm(description, baseTerms)) {
          score += TEXT_WEIGHTS.descriptionTokenMatch;
        }
        if (containsAnyTerm(body, baseTerms)) {
          score += TEXT_WEIGHTS.bodyTokenMatch;
        }

        if (baseTerms.length > 0 && allTermsPresent(baseTerms, title, body, description, topic, tags, categories, groups)) {
          score += TEXT_WEIGHTS.allTermsMatch;
        }

        // Recency only boosts entries that already matched text.
        score += computeRecencyScore(candidate.updated_at, this.halfLifeDays, this.recencyBoost);

        return { ...candidate, score };
      })
      .sort((a, b) => b.score - a.score);
  }
}

/**
 * True when a query term reads as an identifier or acronym rather than a word,
 * judged on the term as typed:
 *
 *   - all capitals with at least two letters: `MQTT`, `E-STOP`, `FTS5`, `ISO-26262`
 *   - letters and digits together: `v2`, `fts5`, `0x80070005`, `CVE-2024-1234`
 *   - letters or digits joined by `.`, `-`, `_` or `/`: `modbus_rtu`, `cert-manager`,
 *     `v2.1`, `10.0.0.0/8`, `sre/on-call`
 *
 * Not: ordinary words in any case (`Docker`, `kubernetes`), a lone capital
 * (`I`), bare numbers (`2024`), anything with whitespace (a multi-word phrase).
 * Pure and deterministic; lexical only.
 */
export function isIdentifierLike(term: string): boolean {
  const value = term.trim();
  if (value.length < 2 || /\s/u.test(value)) return false;
  const letters = value.match(/\p{L}/gu) ?? [];
  const hasDigit = /\p{N}/u.test(value);
  if (letters.length >= 2 && letters.every((letter) => /\p{Lu}/u.test(letter))) return true;
  if (letters.length > 0 && hasDigit) return true;
  return /^[\p{L}\p{N}]+(?:[._\-/][\p{L}\p{N}]+)+$/u.test(value);
}

/** `sequence` appears in `tokens` as consecutive whole tokens. */
function containsTokenSequence(tokens: string[], sequence: string[]): boolean {
  for (let i = 0; i + sequence.length <= tokens.length; i += 1) {
    if (sequence.every((token, k) => tokens[i + k] === token)) return true;
  }
  return false;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function containsText(value: string, query: string): boolean {
  if (!value || !query) return false;
  return value.includes(query);
}

function containsAnyTerm(value: string, terms: string[]): boolean {
  if (!value || terms.length === 0) return false;
  const tokens = tokenize(value);
  return terms.some((term) => {
    if (!term) return false;
    return value.includes(term) || tokens.includes(term);
  });
}

function containsAnyPhrase(value: string, phrases: string[]): boolean {
  if (!value || phrases.length === 0) return false;
  return phrases.some((phrase) => value.includes(phrase));
}

function containsAnyTermOrPhrase(value: string, terms: string[], phrases: string[]): boolean {
  return containsAnyTerm(value, terms) || containsAnyPhrase(value, phrases);
}

function containsAnyTermOrPhraseInList(values: string[], terms: string[], phrases: string[]): boolean {
  return values.some((value) => containsAnyTermOrPhrase(value, terms, phrases));
}

function allTermsPresent(
  terms: string[],
  title: string,
  body: string,
  description: string,
  topic: string,
  tags: string[],
  categories: string[],
  groups: string[],
): boolean {
  return terms.every((term) => {
    return (
      title.includes(term) ||
      body.includes(term) ||
      description.includes(term) ||
      topic.includes(term) ||
      containsAnyTermOrPhraseInList(tags, [term], []) ||
      containsAnyTermOrPhraseInList(categories, [term], []) ||
      containsAnyTermOrPhraseInList(groups, [term], [])
    );
  });
}

function computeRecencyScore(updatedAt: string, halfLifeDays: number, maxBoost: number): number {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const ageDays = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
  // Freshness is only a small multiplier for matched entries.
  return Math.exp(-ageDays / halfLifeDays) * maxBoost;
}
