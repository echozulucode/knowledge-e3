import { describe, expect, it } from 'vitest';
import { excerpt, highlightRanges, plainTextForExcerpt, type ExcerptResult } from '../src/excerpt.js';

// Invisible and astral characters are built from code points so the test source
// says exactly which ones it means.
const ACUTE = String.fromCodePoint(0x301); // combining acute accent
const ROCKET = String.fromCodePoint(0x1f680);
const BOLD_ABC = String.fromCodePoint(0x1d400, 0x1d401, 0x1d402); // mathematical bold A B C (astral letters)
const THUMBS_MEDIUM = String.fromCodePoint(0x1f44d, 0x1f3fd); // thumbs up + skin tone modifier

const terms = (...values: string[]) => ({ terms: values, phrases: [] as string[] });
const marked = (result: { text: string; highlights: [number, number][] }) =>
  result.highlights.map(([start, end]) => result.text.slice(start, end));

const TOKEN_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** The excerpt is a verbatim slice of the collapsed source that starts and ends on word boundaries. */
function expectCleanCut(source: string, result: ExcerptResult): void {
  const collapsed = source.replace(/\s+/g, ' ').trim();
  const at = collapsed.indexOf(result.text);
  expect(at).toBeGreaterThanOrEqual(0);
  const before = collapsed[at - 1];
  const after = collapsed[at + result.text.length];
  expect(before === undefined || !TOKEN_CHAR.test(before)).toBe(true);
  expect(after === undefined || !TOKEN_CHAR.test(after)).toBe(true);
  if (result.truncatedStart) expect(result.text[0]).toMatch(/[^\s\p{P}]/u);
  if (result.truncatedEnd) expect(result.text[result.text.length - 1]).toMatch(/[^\s\p{P}]/u);
  // Never half a surrogate pair at either edge.
  expect(result.text.charCodeAt(0) & 0xfc00).not.toBe(0xdc00);
  expect(result.text.charCodeAt(result.text.length - 1) & 0xfc00).not.toBe(0xd800);
  expect(result.text).not.toContain('…');
}

const FILLER_A =
  'Operators rotate the on-call pager weekly and every handover includes a short written summary of open incidents, ' +
  'pending changes, and anything the next person should watch closely during the first few hours of the shift.';
const FILLER_B =
  'Capacity reviews happen monthly; the platform team compares forecast utilisation against the purchase plan and ' +
  'flags any cluster that is expected to cross seventy percent before the next procurement window closes.';

describe('excerpt', () => {
  it('returns the whole short text with its highlights and no truncation', () => {
    const result = excerpt('Restart the MQTT broker.', terms('mqtt'))!;
    expect(result).toEqual({ text: 'Restart the MQTT broker.', highlights: [[12, 16]], truncatedStart: false, truncatedEnd: false });
  });

  it('returns null when nothing matches, so the caller can fall back to the description', () => {
    expect(excerpt('Restart the broker.', terms('mqtt'))).toBeNull();
    expect(excerpt('Restart the broker.', terms())).toBeNull();
    expect(excerpt('', terms('mqtt'))).toBeNull();
    expect(excerpt('Restart the broker.', terms('--'))).toBeNull();
  });

  it('matches whole tokens only, never a fragment of a word', () => {
    expect(excerpt('The platform team owns it.', terms('orm'))).toBeNull();
    expect(marked(excerpt('An ORM hides SQL; the platform does not.', terms('orm'))!)).toEqual(['ORM']);
  });

  it('cuts a long source on word boundaries at both ends, without ellipsis characters in the text', () => {
    const source = `${FILLER_A} The replica is promoted with pg_ctl promote once lag is zero. ${FILLER_B}`;
    const result = excerpt(source, terms('promoted'))!;

    expect(result.truncatedStart).toBe(true);
    expect(result.truncatedEnd).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(180);
    expect(result.text.length).toBeGreaterThan(120);
    expect(marked(result)).toEqual(['promoted']);
    expectCleanCut(source, result);
  });

  it('never starts or ends mid-word for any window position', () => {
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau'.split(' ');
    const source = Array.from({ length: 120 }, (_, i) => words[i % words.length]).join(' ');
    for (const target of ['kappa', 'sigma', 'alpha', 'tau', 'omicron']) {
      for (const maxChars of [17, 40, 73, 180]) {
        const result = excerpt(source, terms(target), { maxChars })!;
        expectCleanCut(source, result);
        expect(marked(result)).toContain(target);
      }
    }
  });

  it('trims punctuation and space left at a cut edge, but keeps a sentence-final period at the real end', () => {
    const source = `${FILLER_A} Finally, rotate the broker certificate.`;
    const result = excerpt(source, terms('certificate'))!;
    expect(result.truncatedEnd).toBe(false);
    expect(result.text.endsWith('certificate.')).toBe(true);
    expectCleanCut(source, result);
  });

  it('matches a phrase as a whole token sequence, allowing whitespace and punctuation between its words', () => {
    const result = excerpt('Then run pg_ctl   promote on the replica.', { terms: [], phrases: ['pg ctl promote'] })!;
    expect(result.text).toBe('Then run pg_ctl promote on the replica.');
    expect(marked(result)).toEqual(['pg_ctl promote']);
    expect(excerpt('Run promote pg_ctl.', { terms: [], phrases: ['pg ctl promote'] })).toBeNull();
    // Whole words only: a phrase never matches inside a longer word.
    expect(excerpt('Kubernetes nodes', { terms: [], phrases: ['kube'] })).toBeNull();
  });

  it('matches a hyphenated or underscored term as its token sequence', () => {
    expect(marked(excerpt('Install cert-manager first.', terms('cert-manager'))!)).toEqual(['cert-manager']);
    expect(marked(excerpt('Install cert manager first.', terms('cert_manager'))!)).toEqual(['cert manager']);
  });

  it('matches the word still being typed as a prefix and highlights the whole word', () => {
    const result = excerpt('Poll the Modbus RTU gateway every second.', { terms: ['modb'], phrases: [], prefixTerm: 'modb' })!;
    expect(marked(result)).toEqual(['Modbus']);
    // Without the prefix flag the same term is exact, so it matches nothing.
    expect(excerpt('Poll the Modbus RTU gateway.', terms('modb'))).toBeNull();
    // A prefix term the caller did not repeat among the terms still matches.
    expect(marked(excerpt('Poll the Modbus gateway.', { terms: ['poll'], phrases: [], prefixTerm: 'gate' })!)).toEqual(['Poll', 'gateway']);
    // Too short to expand: one character would light up half the text.
    expect(excerpt('Poll the Modbus gateway.', { terms: [], phrases: [], prefixTerm: 'm' })).toBeNull();
    // The prefix applies to the last token of a multi-token term only.
    expect(marked(excerpt('Install cert-manager first.', { terms: ['cert-man'], phrases: [], prefixTerm: 'cert-man' })!)).toEqual(['cert-manager']);
    expect(excerpt('Install certificate-manager.', { terms: ['cert-man'], phrases: [], prefixTerm: 'cert-man' })).toBeNull();
  });

  it('prefers the window holding the most distinct terms over an earlier one with fewer', () => {
    const source = `Docker is mentioned first. ${FILLER_A} ${FILLER_B} Here the Docker layer cache finally misses. ${FILLER_A}`;
    const result = excerpt(source, terms('docker', 'cache'))!;
    expect(marked(result)).toEqual(['Docker', 'cache']);
    expect(result.truncatedStart).toBe(true);
    expectCleanCut(source, result);
  });

  it('counts a repeated term once, and takes the earliest window on a tie', () => {
    const source = `One docker here. ${FILLER_A} Docker docker docker. ${FILLER_B}`;
    const result = excerpt(source, terms('docker'))!;
    expect(result.truncatedStart).toBe(false);
    expect(result.text.startsWith('One docker here.')).toBe(true);
  });

  it('merges overlapping and nested matches into non-overlapping ranges', () => {
    const result = excerpt('Install cert-manager now.', { terms: ['cert-manager', 'manager'], phrases: ['cert manager'] })!;
    expect(result.highlights).toEqual([[8, 20]]);
    expect(highlightRanges('mqtt broker mqtt', { terms: ['mqtt', 'broker'], phrases: ['broker mqtt'] })).toEqual([
      [0, 4],
      [5, 16],
    ]);
  });

  it('keeps offsets exact around emoji and astral letters', () => {
    const source = `${ROCKET} Deploy the MQTT bridge ${ROCKET}${THUMBS_MEDIUM} then ${BOLD_ABC} checks.`;
    const result = excerpt(source, terms('mqtt', BOLD_ABC))!;
    expect(marked(result)).toEqual(['MQTT', BOLD_ABC]);
    for (const [start, end] of result.highlights) expect(end).toBeGreaterThan(start);
  });

  it('never cuts through an emoji or a surrogate pair when the text around the match has no spaces', () => {
    const run = `${ROCKET}${THUMBS_MEDIUM}`.repeat(60);
    const source = `${run}mqtt${run}`;
    const result = excerpt(source, terms('mqtt'), { maxChars: 40 })!;
    expect(marked(result)).toEqual(['mqtt']);
    expectCleanCut(source, result);
  });

  it('folds case and diacritics, and keeps combining marks inside their word', () => {
    const decomposed = `Order a Cafe${ACUTE} au lait.`;
    const result = excerpt(decomposed, terms('café'))!;
    expect(marked(result)).toEqual([`Cafe${ACUTE}`]);
    expect(marked(excerpt(decomposed, terms('CAFE'))!)).toEqual([`Cafe${ACUTE}`]);
    expect(marked(excerpt('Upload your Résumé today.', terms('resume'))!)).toEqual(['Résumé']);
    // A cut next to the decomposed word never separates the letter from its accent.
    const long = `${FILLER_A} Cafe${ACUTE} ${FILLER_B}`;
    const cut = excerpt(long, terms('cafe'), { maxChars: 30 })!;
    expect(marked(cut)).toEqual([`Cafe${ACUTE}`]);
    expectCleanCut(long, cut);
  });

  it('includes a whole match even when it is longer than maxChars', () => {
    const source = `${FILLER_A} the replica must be promoted before traffic returns ${FILLER_B}`;
    const result = excerpt(source, { terms: [], phrases: ['the replica must be promoted before traffic returns'] }, { maxChars: 10 })!;
    expect(marked(result)).toEqual(['the replica must be promoted before traffic returns']);
    expectCleanCut(source, result);
  });

  it('handles a very long source quickly and near its end', () => {
    const source = `${`${FILLER_A} ${FILLER_B} `.repeat(400)}The needle is here.`;
    const started = Date.now();
    const result = excerpt(source, terms('needle', 'the'))!;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(marked(result)).toContain('needle');
    expect(result.truncatedEnd).toBe(false);
    expect(result.text.endsWith('The needle is here.')).toBe(true);
    expectCleanCut(source, result);
  });

  it('collapses whitespace in the returned text and keeps highlights aligned with it', () => {
    const result = excerpt('  Restart\n\n the   MQTT\tbroker  ', terms('mqtt', 'broker'))!;
    expect(result.text).toBe('Restart the MQTT broker');
    expect(marked(result)).toEqual(['MQTT', 'broker']);
  });
});

describe('highlightRanges', () => {
  it('returns sorted, merged ranges into the title exactly as given', () => {
    const title = 'MQTT  broker ACLs for MQTT bridges';
    const ranges = highlightRanges(title, { terms: ['mqtt', 'bridg'], phrases: ['broker acls'], prefixTerm: 'bridg' });
    expect(ranges).toEqual([
      [0, 4],
      [6, 17],
      [22, 26],
      [27, 34],
    ]);
    expect(ranges.map(([s, e]) => title.slice(s, e))).toEqual(['MQTT', 'broker ACLs', 'MQTT', 'bridges']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(highlightRanges('Runbook: Postgres failover', terms('mqtt'))).toEqual([]);
  });
});

describe('plainTextForExcerpt', () => {
  it('turns wiki links into their label or target instead of leaving bracket fragments', () => {
    expect(plainTextForExcerpt('See [[getting-started|Getting Started]] and [[Install]] or [[Setup#Proxy]].')).toBe(
      'See Getting Started and Install or Setup Proxy.',
    );
  });

  it('keeps link text, drops images, embeds and URLs', () => {
    expect(
      plainTextForExcerpt('Read [the guide](https://example.com/a_(b)) ![diagram](img.png) ![[chart.png]] or [ref text][1] <https://x.io>.'),
    ).toBe('Read the guide or ref text https://x.io.');
    expect(plainTextForExcerpt('[![badge](b.svg)](https://ci) Build passing')).toBe('Build passing');
  });

  it('removes frontmatter, headings, list, quote and table markers, and HTML', () => {
    const md = [
      '---',
      'title: MQTT',
      'tags: [mqtt]',
      '---',
      '# MQTT broker #',
      '',
      '> [!note] Read first',
      '> Quoted **bold** line',
      '',
      '- item one',
      '* [x] item two',
      '12. item three',
      '',
      '| Key | Value |',
      '|-----|:-----:|',
      '| qos | 1 |',
      '',
      '<div class="warn">Careful <br/> now</div>',
      '<!-- hidden -->',
      '***',
      'Setext',
      '======',
    ].join('\n');
    expect(plainTextForExcerpt(md)).toBe(
      'MQTT broker Read first Quoted bold line item one item two item three Key Value qos 1 Careful now Setext',
    );
  });

  it('strips emphasis without eating snake_case, and keeps code text verbatim but collapsed', () => {
    expect(plainTextForExcerpt('Use *care* and __strong__ ~~old~~ with modbus_rtu_frame and `a_b*c*`.')).toBe(
      'Use care and strong old with modbus_rtu_frame and a_b*c*.',
    );
    expect(plainTextForExcerpt('Run:\n\n```bash\nkubectl drain \\\n  --ignore-daemonsets   node-1\n```\n\nDone.')).toBe(
      'Run: kubectl drain \\ --ignore-daemonsets node-1 Done.',
    );
    // An unclosed fence runs to the end of the document.
    expect(plainTextForExcerpt('Before\n~~~\n# not a heading\n*not emphasis*')).toBe('Before # not a heading *not emphasis*');
  });

  it('decodes entities after removing tags, honours backslash escapes, and drops footnote markers', () => {
    expect(plainTextForExcerpt('Use &lt;div&gt; &amp; \\*literal\\* stars[^1].\n\n[^1]: The footnote.')).toBe(
      'Use <div> & *literal* stars. The footnote.',
    );
  });

  it('handles CRLF, a byte-order mark and empty input', () => {
    expect(plainTextForExcerpt(`${String.fromCharCode(0xfeff)}---\r\ntitle: x\r\n---\r\n## Heading\r\nBody`)).toBe('Heading Body');
    expect(plainTextForExcerpt('')).toBe('');
  });

  it('feeds excerpt so a cut can never land inside Markdown syntax (issue 114)', () => {
    const md = `${FILLER_A}\n\nStart with [[getting-started|Getting Started]] before you configure the MQTT bridge.\n\n${FILLER_B}`;
    const result = excerpt(plainTextForExcerpt(md), terms('mqtt'))!;
    expect(result.text).not.toMatch(/\[\[|\]\]|\]\(/);
    expect(result.text).toContain('Getting Started');
    expect(marked(result)).toEqual(['MQTT']);
  });
});
