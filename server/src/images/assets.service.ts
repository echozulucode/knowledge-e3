import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { loadServerConfig } from '../config/server-config.js';
import {
  descriptorSidecarName,
  isDescriptorSidecar,
  parseDescriptor,
  serializeDescriptor,
  type AssetDescriptor,
} from './asset-descriptor.js';
import type { AssetStore, AssetStoreCapabilities } from './asset-store.js';

/**
 * Physical store for image bytes. Files live in the bundle's `assets/` directory
 * so they travel with the git-of-record repo and OKF bundle exports (non-`.md`
 * files don't affect OKF conformance). Location mirrors the git config:
 *   - GIT_MIRROR_DIR set        → <dir>/assets
 *   - git enabled / GIT_MIRROR_ROOT → <root>/main/assets  (shared main bundle)
 *   - otherwise                  → ./data/assets
 */
/**
 * Local-filesystem asset store (ADR-0003) — the open, self-hosted default
 * backend for the {@link AssetStore} seam. Bytes live in the bundle's `assets/`
 * directory so they travel with the git-of-record repo and OKF bundle exports.
 * The cloud edition supplies an object-store backend behind the same interface.
 */
@Injectable()
export class AssetsService implements AssetStore {
  private readonly dir: string;

  /** Local disk: no presigned URLs, no server-side copy. */
  readonly capabilities: AssetStoreCapabilities = {
    presignedDelivery: false,
    serverSideCopy: false,
  };

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
    rmSync(join(this.dir, descriptorSidecarName(file)), { force: true });
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !isDescriptorSidecar(e.name))
      .map((e) => e.name);
  }

  /** Write the git-tracked sidecar descriptor next to the bytes (ADR-0003). */
  writeDescriptor(d: AssetDescriptor): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, descriptorSidecarName(d.file)), serializeDescriptor(d), 'utf8');
  }

  /**
   * Every descriptor found under an assets directory. Used by rebuild-from-git to
   * repopulate the derived media index from the git-tracked source of truth.
   * `dir` defaults to this instance's assets dir; rebuild passes the working
   * tree's `assets/` explicitly. Malformed sidecars are skipped, not fatal.
   */
  readDescriptors(dir: string = this.dir): AssetDescriptor[] {
    if (!existsSync(dir)) return [];
    const out: AssetDescriptor[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !isDescriptorSidecar(entry.name)) continue;
      const parsed = parseDescriptor(readFileSync(join(dir, entry.name), 'utf8'));
      if (parsed) out.push(parsed);
    }
    return out;
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
