import { describe, expect, it } from 'vitest';
import { FtsRecencyRanker, IDENTIFIER_MATCH_MULTIPLIER, isIdentifierLike, type PageCandidate } from '../src/ranker.js';

const NOW = new Date().toISOString();

function candidate(id: string, over: Partial<PageCandidate> = {}): PageCandidate {
  return { id, slug: id, title: id, updated_at: NOW, fts_rank: 0, ...over };
}

describe('isIdentifierLike', () => {
  it.each(['MQTT', 'FTS5', 'E-STOP', 'ISO-26262', 'CVE-2024-1234', 'modbus_rtu', 'cert-manager', 'v2.1', 'v2', 'fts5', '0x80070005', '10.0.0.0/8', 'OK'])(
    'classifies %s as an identifier',
    (term) => expect(isIdentifierLike(term)).toBe(true),
  );

  it.each(['Docker', 'kubernetes', 'mqtt', 'I', 'a', '2024', '', 'pod disruption', 'MQTT broker', '-', 'e.g.', 'foo-', '_private'])(
    'classifies %j as an ordinary word',
    (term) => expect(isIdentifierLike(term)).toBe(false),
  );
});

describe('FtsRecencyRanker identifier boost', () => {
  const ranker = new FtsRecencyRanker();

  // A page ABOUT MQTT (title + tag) against a page that says MQTT in every prose
  // field. Without the boost the prose page's stacked signals win (185 > 170).
  // (A single-term query found anywhere in a title scores the whole-query title
  // weight, 100, not the 75 of one token among several.)
  const about = candidate('about', { title: 'MQTT broker ACLs', tags: ['mqtt'] });
  const mentions = candidate('mentions', {
    title: 'Gateway onboarding',
    description: 'Point the MQTT bridge at the plant broker.',
    body: 'The gateway speaks MQTT to the broker.',
    topic: 'mqtt',
    categories: ['mqtt'],
  });

  it('ranks the page titled and tagged with an acronym above one that only mentions it in prose', () => {
    expect(ranker.score('MQTT', [mentions, about]).map((r) => r.id)).toEqual(['about', 'mentions']);
  });

  it('applies only to identifier-like terms: the same page for a lowercase word is not boosted', () => {
    const [aboutUpper] = ranker.score('MQTT', [about]);
    const [aboutLower] = ranker.score('mqtt', [about]);
    expect(aboutUpper!.score - aboutLower!.score).toBeCloseTo((100 + 70) * (IDENTIFIER_MATCH_MULTIPLIER - 1), 5);
    // Unboosted, the stacked prose signals win — which is exactly what the boost corrects.
    expect(ranker.score('mqtt', [mentions, about]).map((r) => r.id)).toEqual(['mentions', 'about']);
  });

  it('multiplies the title and tag signals only, never body, description or taxonomy', () => {
    const [upper] = ranker.score('MQTT', [mentions]);
    const [lower] = ranker.score('mqtt', [mentions]);
    expect(upper!.score).toBeCloseTo(lower!.score, 5);
  });

  it('needs a whole-token match: an identifier inside a longer title word is not boosted', () => {
    const inside = candidate('inside', { title: 'MQTTS gateway', tags: ['mqtts'] });
    const [upper] = ranker.score('MQTT', [inside]);
    const [lower] = ranker.score('mqtt', [inside]);
    // The existing substring title/tag signals still apply; the multiplier does not.
    expect(upper!.score).toBeCloseTo(lower!.score, 5);
  });

  it('matches a multi-token identifier as its token sequence in the title and in a tag', () => {
    const cve = candidate('cve', { title: 'CVE-2024-1234 mitigation', tags: ['cve-2024-1234'] });
    const [boosted] = ranker.score('CVE-2024-1234', [cve]);
    // The same page found by an ordinary word in the same title and tag positions.
    const [plain] = ranker.score('mitigation', [candidate('plain', { title: 'CVE-2024-1234 mitigation', tags: ['mitigation'] })]);
    expect(boosted!.score).toBeCloseTo(plain!.score + (100 + 70) * (IDENTIFIER_MATCH_MULTIPLIER - 1), 5);
  });

  it('counts an identifier token sequence as a title hit even where the substring check misses it', () => {
    const page = candidate('m', { title: 'Modbus RTU framing', body: 'modbus_rtu frames carry a CRC.' });
    const other = candidate('o', { title: 'Serial wiring', body: 'modbus_rtu over RS-485.', tags: [] });
    const ranked = ranker.score('modbus_rtu', [other, page]);
    expect(ranked.map((r) => r.id)).toEqual(['m', 'o']);
    expect(ranked[0]!.score - ranked[1]!.score).toBeCloseTo(75 * IDENTIFIER_MATCH_MULTIPLIER, 5);
  });

  it('boosts a quoted single-token identifier too', () => {
    const [quoted] = ranker.score('"FTS5"', [candidate('fts', { title: 'Search on FTS5', tags: ['fts5'] })]);
    const [word] = ranker.score('"search"', [candidate('fts', { title: 'Search on FTS5', tags: ['search'] })]);
    expect(quoted!.score).toBeGreaterThan(word!.score);
  });
});
