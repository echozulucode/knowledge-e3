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
}

export interface RankedResult extends PageCandidate {
  score: number;
}

export interface Ranker {
  readonly name: string;
  score(query: string, candidates: PageCandidate[]): RankedResult[];
}

const TEXT_WEIGHTS = {
  exactTitleMatch: 100,
  phraseTitleMatch: 90,
  titleTokenMatch: 75,
  tagMatch: 70,
  phraseBodyMatch: 60,
  topicMatch: 55,
  categoryMatch: 45,
  groupMatch: 45,
  bodyTokenMatch: 35,
  allTermsMatch: 12,
};

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

    return candidates
      .map((candidate) => {
        const title = normalize(candidate.title);
        const body = normalize(candidate.body ?? '');
        const topic = normalize(candidate.topic ?? '');
        const tags = (candidate.tags ?? []).map(normalize);
        const categories = (candidate.categories ?? []).map(normalize);
        const groups = (candidate.groups ?? []).map(normalize);

        let score = candidate.fts_rank;

        if (containsText(title, fullQuery)) {
          score += TEXT_WEIGHTS.exactTitleMatch;
        } else if (containsAnyPhrase(title, phraseBonus)) {
          score += TEXT_WEIGHTS.phraseTitleMatch;
        } else if (containsAnyTerm(title, baseTerms)) {
          score += TEXT_WEIGHTS.titleTokenMatch;
        }

        if (containsAnyTermOrPhraseInList(tags, baseTerms, phraseBonus)) {
          score += TEXT_WEIGHTS.tagMatch;
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
        if (containsAnyTerm(body, baseTerms)) {
          score += TEXT_WEIGHTS.bodyTokenMatch;
        }

        if (baseTerms.length > 0 && allTermsPresent(baseTerms, title, body, topic, tags, categories, groups)) {
          score += TEXT_WEIGHTS.allTermsMatch;
        }

        // Recency only boosts entries that already matched text.
        score += computeRecencyScore(candidate.updated_at, this.halfLifeDays, this.recencyBoost);

        return { ...candidate, score };
      })
      .sort((a, b) => b.score - a.score);
  }
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
  topic: string,
  tags: string[],
  categories: string[],
  groups: string[],
): boolean {
  return terms.every((term) => {
    return (
      title.includes(term) ||
      body.includes(term) ||
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
