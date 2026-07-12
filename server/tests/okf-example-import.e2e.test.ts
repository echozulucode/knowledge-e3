import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { validateBundle } from '@echozedlabs/okf';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { OkfImportService } from '../src/okf/okf-import.service.js';
import { WikiService } from '../src/wiki/wiki.service.js';

/** Read every .md file under a directory as {path, content} (skips .git). */
function readDir(root: string, sub = ''): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const entry of readdirSync(join(root, sub), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...readDir(root, rel));
    else if (entry.name.endsWith('.md')) out.push({ path: rel, content: readFileSync(join(root, rel), 'utf8') });
  }
  return out;
}

const EXAMPLE_DIR = resolve(process.cwd(), '../examples/okf-demo');

/**
 * Proves the shipped demo bundle (examples/okf-demo) is a valid OKF bundle and
 * imports cleanly — the turnkey artifact used in DEMO.md. Guards the demo so a
 * change to the bundle or the importer can't silently break the walkthrough.
 */
describe('OKF example bundle import (demo) e2e', () => {
  let app: INestApplication;
  let importer: OkfImportService;
  let wiki: WikiService;
  let adminId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    importer = app.get(OkfImportService);
    wiki = app.get(WikiService);
  });

  afterEach(async () => app.close());

  it('is a conformant bundle that imports with cross-links restored', async () => {
    const files = readDir(EXAMPLE_DIR);
    expect(files.length).toBeGreaterThan(0);

    // The shipped bundle must be OKF-conformant.
    const report = validateBundle({ files });
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(3);

    // Import as an external bundle (no e3_id) → all three are created.
    const actor = { id: adminId, role: 'admin' as const };
    const result = await importer.importBundleFiles(actor, files);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);

    // Pure-OKF path links are restored to E3 wiki-links, and the derived graph
    // (backlinks) is built from them. Both other concepts link to GW.
    const gwBacklinks = await wikiBacklinksFor('Gravitational Waves');
    const sourceTitles = gwBacklinks.map((b) => b.source_title).sort();
    // Both General Relativity and LIGO link to Gravitational Waves.
    expect(sourceTitles).toContain('General Relativity');
    expect(sourceTitles).toContain('LIGO');
  });

  async function wikiBacklinksFor(title: string) {
    return wiki.backlinks({ id: 'unused', slug: 'unused', title });
  }
});
