import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { loadServerConfig } from '../config/server-config.js';

/**
 * Physical store for image bytes. Files live in the bundle's `assets/` directory
 * so they travel with the git-of-record repo and OKF bundle exports (non-`.md`
 * files don't affect OKF conformance). Location mirrors the git config:
 *   - GIT_MIRROR_DIR set        → <dir>/assets
 *   - git enabled / GIT_MIRROR_ROOT → <root>/main/assets  (shared main bundle)
 *   - otherwise                  → ./data/assets
 */
@Injectable()
export class AssetsService {
  private readonly dir: string;

  constructor() {
    this.dir = resolveAssetsDir();
  }

  get directory(): string {
    return this.dir;
  }

  write(file: string, bytes: Buffer): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, file), bytes);
  }

  read(file: string): Buffer | null {
    const abs = join(this.dir, file);
    return existsSync(abs) ? readFileSync(abs) : null;
  }

  exists(file: string): boolean {
    return existsSync(join(this.dir, file));
  }

  remove(file: string): void {
    rmSync(join(this.dir, file), { force: true });
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  }
}

function resolveAssetsDir(): string {
  // Explicit override wins (used by tests and non-standard deployments).
  const override = process.env['KNOWLEDGE_E3_ASSETS_DIR'];
  if (override) return abs(override);
  const single = process.env['GIT_MIRROR_DIR'];
  if (single) return join(abs(single), 'assets');
  const envRoot = process.env['GIT_MIRROR_ROOT'];
  const cfg = loadServerConfig();
  if (envRoot || cfg.git.enabled) {
    return join(abs(envRoot ?? cfg.git.root), 'main', 'assets');
  }
  return resolve(process.cwd(), 'data', 'assets');
}

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}
