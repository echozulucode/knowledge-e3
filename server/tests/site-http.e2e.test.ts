/**
 * `GET /site` and `GET /site/links` — the tenant's identity and its curated
 * front-page links (reader plan §4, R2.1 and R2.4).
 *
 * The links assertion is the interesting one: it writes a `links:` block into a
 * topic's bundle `index.md` on disk and reads it back over HTTP, which is the
 * whole claim — curation lives in git beside the content, so it survives a
 * rebuild and travels with a backup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { resetServerConfig } from '../src/config/server-config.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';

const CONFIG_DIRS: string[] = [];

/** Point the server at a config file holding `yaml`, and drop the memoized load. */
function useConfig(yaml: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'e3-site-http-'));
  CONFIG_DIRS.push(dir);
  const file = join(dir, 'knowledge-e3.config.yaml');
  writeFileSync(file, yaml, 'utf8');
  process.env['KNOWLEDGE_E3_CONFIG'] = file;
  resetServerConfig();
}

describe('site config over HTTP', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    cookie = (await seedAdminAndLogin(app)).cookie;
  });

  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_CONFIG'];
    resetServerConfig();
    for (const dir of CONFIG_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('answers with nulls everywhere when nothing is configured', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/site').expect(200);
    expect(res.body).toEqual({
      home_topic: null,
      name: null,
      short_name: null,
      logo: null,
      logo_dark: null,
      favicon: null,
      tagline: null,
      search_placeholder: null,
    });
  });

  it('surfaces the configured branding, anonymously, and falls the dark logo back to the light one', async () => {
    useConfig(
      [
        'site:',
        '  homeTopic: main',
        '  name: "Acme Engineering Knowledge"',
        '  shortName: Acme',
        '  logo: "/assets/8f21c0d34ab19e57.svg"',
        '  tagline: "What do you want to do with AI?"',
        '  searchPlaceholder: "Search tools, topics, guidance…"',
      ].join('\n'),
    );
    // No cookie: the front page has to render for a visitor who is not signed in.
    const res = await request(app.getHttpServer()).get('/api/v1/site').expect(200);
    expect(res.body).toMatchObject({
      home_topic: 'main',
      name: 'Acme Engineering Knowledge',
      short_name: 'Acme',
      logo: '/assets/8f21c0d34ab19e57.svg',
      logo_dark: '/assets/8f21c0d34ab19e57.svg',
      favicon: null,
      tagline: 'What do you want to do with AI?',
      search_placeholder: 'Search tools, topics, guidance…',
    });
  });

  it('drops a malformed logo and still serves the rest, so the front page never goes missing', async () => {
    useConfig('site:\n  name: Acme\n  logo: "javascript:alert(1)"\n');
    const res = await request(app.getHttpServer()).get('/api/v1/site').expect(200);
    expect(res.body.logo).toBeNull();
    expect(res.body.logo_dark).toBeNull();
    expect(res.body.name).toBe('Acme');
  });

  it('reads curated links from the topic bundle index.md, for anyone, in authored order', async () => {
    const topic = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Main', slug: 'main' })
      .expect(201);
    const target = await app.get(ContentPathResolver).resolve(topic.body.topic.id as string);
    const indexPath = join(target.repoDir, dirname(target.conceptDir), 'index.md');
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(
      indexPath,
      [
        '---',
        'okf_version: "0.2"',
        'presentation: portal',
        'links:',
        '  - label: "Onboarding checklist"',
        '    to: "/p/onboarding"',
        '  - label: "Sections"',
        '    to: "/sections"',
        '    description: "Everything we curate"',
        '  - label: "Tool request form"',
        '    href: "https://intranet.example/tools/request"',
        '  - label: "Dropped"',
        '    href: "javascript:alert(1)"',
        '---',
        '',
        '# Main Index',
        '',
        '## Concepts',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await request(app.getHttpServer()).get('/api/v1/site/links?topic=main').expect(200);
    expect(res.body.links).toEqual([
      { label: 'Onboarding checklist', to: '/p/onboarding' },
      { label: 'Sections', to: '/sections', description: 'Everything we curate' },
      { label: 'Tool request form', href: 'https://intranet.example/tools/request' },
    ]);

    // With no `?topic=`, the configured home topic answers — which is what the
    // front page asks for.
    useConfig('site: { homeTopic: main }\n');
    const home = await request(app.getHttpServer()).get('/api/v1/site/links').expect(200);
    expect(home.body.links).toHaveLength(3);
  });

  it('answers with an empty list — never an error — for an unknown, unnamed or uncurated topic', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Bare', slug: 'bare' })
      .expect(201);
    for (const url of ['/api/v1/site/links', '/api/v1/site/links?topic=nope', '/api/v1/site/links?topic=bare']) {
      const res = await request(app.getHttpServer()).get(url).expect(200);
      expect(res.body).toEqual({ links: [] });
    }
  });
});
