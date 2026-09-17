#!/usr/bin/env node
/**
 * Fail if any text file in the working tree contains a NUL byte.
 *
 * Why this exists: three times (issues 4 and 25, lesson 29) an editing tool left
 * runs of NUL bytes in source files — sometimes masking a truncation — and the
 * only detector was a cascade of `TS1127 Invalid character` errors, or nothing
 * at all for files tsc never reads (JSON, YAML, Markdown). This makes the next
 * occurrence a one-line failure naming the file.
 *
 * Scope: every tracked or untracked-but-not-ignored file (`git ls-files`) whose
 * extension is a text format. Binary formats legitimately contain NULs, so the
 * list is an allowlist rather than a guess at "is this binary".
 *
 *   node scripts/check-nul-bytes.mjs     # run by `pnpm lint` and `just lint`
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.md', '.css', '.html', '.svg',
  '.py', '.ps1', '.sh', '.sql', '.toml', '.txt', '.feature',
]);
const TEXT_NAMES = new Set(['justfile', 'Dockerfile', '.gitattributes', '.gitignore', '.npmrc', '.editorconfig']);

const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean);

const offenders = [];
let scanned = 0;
for (const rel of listed) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (!TEXT_EXTENSIONS.has(extname(base).toLowerCase()) && !TEXT_NAMES.has(base)) continue;
  let bytes;
  try {
    bytes = readFileSync(resolve(ROOT, rel));
  } catch {
    continue; // listed but deleted in the working tree
  }
  scanned += 1;
  const at = bytes.indexOf(0);
  if (at !== -1) offenders.push(`${rel} (first NUL at byte ${at})`);
}

if (offenders.length > 0) {
  console.error(`check-nul-bytes: ${offenders.length} text file(s) contain NUL bytes (issue 25):`);
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`check-nul-bytes: ${scanned} text files, no NUL bytes`);
