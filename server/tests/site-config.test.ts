/**
 * Tenant branding in `site:` (reader plan §4, R2.1).
 *
 * Two rules are load-bearing and are asserted here rather than assumed:
 *   - unset means *exactly today's behaviour* — every field comes back
 *     undefined, and the web app supplies the built-in mark and wordmark;
 *   - a malformed value is dropped, never thrown. `git.commit.*` throws because
 *     it is a durability knob; a logo is not, and an instance must never lose its
 *     front page to a typo in a URL (the precedent `site.homeTopic` set).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServerConfig, resetServerConfig, isSiteBrandingAsset, declareSiteAssets } from '../src/config/server-config.js';

function withConfig(yaml: string): ReturnType<typeof loadServerConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'e3-site-'));
  const file = join(dir, 'knowledge-e3.config.yaml');
  writeFileSync(file, yaml, 'utf8');
  process.env['KNOWLEDGE_E3_CONFIG'] = file;
  resetServerConfig();
  const cfg = loadServerConfig();
  rmSync(dir, { recursive: true, force: true });
  return cfg;
}

describe('site branding config', () => {
  afterEach(() => {
    delete process.env['KNOWLEDGE_E3_CONFIG'];
    resetServerConfig();
  });

  it('is entirely empty when unset — no site block at all', () => {
    resetServerConfig();
    expect(loadServerConfig().site).toEqual({});
  });

  it('is still empty when the block exists but names nothing', () => {
    expect(withConfig('site: {}\n').site).toEqual({});
  });

  it('reads every branding field, trimming as `str` does elsewhere', () => {
    const cfg = withConfig(
      [
        'site:',
        '  homeTopic: main',
        '  name: "Acme Engineering Knowledge"',
        '  shortName: Acme',
        '  logo: "/assets/8f21c0d34ab19e57.svg"',
        '  logoDark: "/assets/1c93aa70be55d218.svg"',
        '  favicon: "/assets/4d0e77bb21a9c614.png"',
        '  tagline: "  What do you want to do with AI?  "',
        '  searchPlaceholder: "Search tools, topics, guidance…"',
      ].join('\n'),
    );
    expect(cfg.site).toEqual({
      homeTopic: 'main',
      name: 'Acme Engineering Knowledge',
      shortName: 'Acme',
      logo: '/assets/8f21c0d34ab19e57.svg',
      logoDark: '/assets/1c93aa70be55d218.svg',
      favicon: '/assets/4d0e77bb21a9c614.png',
      tagline: 'What do you want to do with AI?',
      searchPlaceholder: 'Search tools, topics, guidance…',
    });
  });

  it('accepts an absolute https logo (a CDN), which is the other legitimate form', () => {
    expect(withConfig('site: { logo: "https://cdn.example.com/acme.svg" }\n').site.logo).toBe(
      'https://cdn.example.com/acme.svg',
    );
  });

  it.each([
    ['a container filesystem path dressed as a relative one', 'assets/acme.svg'],
    ['a relative path', './logo.png'],
    ['a Windows path', 'C:\logos\acme.png'],
    ['a protocol-relative URL that silently downgrades', '//cdn.example.com/acme.svg'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:image/svg+xml;base64,AAAA'],
    ['a traversal', '/assets/../../etc/passwd'],
    ['a number', '42'],
  ])('drops %s and keeps the rest of the block loading', (_why, value) => {
    const cfg = withConfig(`site:\n  name: Acme\n  logo: ${JSON.stringify(value)}\n`);
    expect(cfg.site.logo).toBeUndefined();
    // The point of dropping rather than throwing: everything else still applies.
    expect(cfg.site.name).toBe('Acme');
  });

  it('ignores a site block that is not a mapping at all', () => {
    expect(withConfig('site: "main"\n').site).toEqual({});
  });

  it('recognises the declared branding files as public assets, and nothing else', () => {
    withConfig(
      [
        'site:',
        '  logo: "/assets/aaaa1111.svg"',
        '  logoDark: "/assets/bbbb2222.svg"',
        '  favicon: "/assets/cccc3333.png"',
        '  tagline: "/assets/dddd4444.png"',
      ].join('\n'),
    );
    expect(isSiteBrandingAsset('aaaa1111.svg')).toBe(true);
    expect(isSiteBrandingAsset('bbbb2222.svg')).toBe(true);
    expect(isSiteBrandingAsset('cccc3333.png')).toBe(true);
    // Only the three image fields grant public access — not any other string.
    expect(isSiteBrandingAsset('dddd4444.png')).toBe(false);
    expect(isSiteBrandingAsset('eeee5555.png')).toBe(false);
  });

  it('grants nothing when the logo is hosted off-instance', () => {
    withConfig('site: { logo: "https://cdn.example.com/acme.svg" }\n');
    expect(isSiteBrandingAsset('acme.svg')).toBe(false);
  });

  it('extends the same grant to chrome images an admin declared in the app', () => {
    // A pinned-topic cover has exactly the logo's problem: it is embedded in
    // the front page's chrome rather than in any published item, so nothing
    // links it and it would 404 for the anonymous visitor the front page is
    // mostly for. Same predicate, not a second one with its own rules.
    withConfig('site: { logo: "/assets/aaaa1111.svg" }\n');
    declareSiteAssets(['/assets/cover1111.png', '/assets/cover2222.png']);

    expect(isSiteBrandingAsset('aaaa1111.svg')).toBe(true);
    expect(isSiteBrandingAsset('cover1111.png')).toBe(true);
    expect(isSiteBrandingAsset('cover2222.png')).toBe(true);
    expect(isSiteBrandingAsset('nothing.png')).toBe(false);

    // The list is a REPLACEMENT, not an accumulation: un-pinning a topic has to
    // take its cover's public grant away with it.
    declareSiteAssets(['/assets/cover2222.png']);
    expect(isSiteBrandingAsset('cover1111.png')).toBe(false);
    expect(isSiteBrandingAsset('cover2222.png')).toBe(true);

    // Only a root-relative /assets/ URL grants anything — an off-instance cover
    // declares nothing here, the same way an off-instance logo does not.
    declareSiteAssets(['https://cdn.example.com/cover.png', null, undefined, '/logo/ke3.png']);
    expect(isSiteBrandingAsset('cover.png')).toBe(false);
    expect(isSiteBrandingAsset('ke3.png')).toBe(false);
  });
});
