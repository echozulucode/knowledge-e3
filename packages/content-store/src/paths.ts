import { basename } from 'node:path';

/** Normalize a path to forward slashes (bundle paths are always posix). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True when the path's basename is a bundle-reserved file (`index.md`, `log.md`, ...). */
export function isReservedPath(path: string, reserved: readonly string[]): boolean {
  return reserved.includes(basename(toPosix(path)));
}

/** `topic/concepts/my-page.md` → `my-page`. */
export function slugFromPath(path: string): string {
  return basename(toPosix(path)).replace(/\.md$/, '');
}

/**
 * Concept directory for a topic, mirroring `RoutingRevisionMirror.resolve`
 * (server/src/storage/routing-revision-mirror.adapter.ts): a dedicated repo is
 * a self-contained bundle (`concepts/`), while a topic in the shared main repo
 * lives in its own subtree (`<topicSlug>/concepts/`). A null slug falls back to
 * the routing adapter's `default` topic.
 */
export function conceptDirFor(topicSlug: string | null, opts: { dedicated: boolean }): string {
  if (opts.dedicated) return 'concepts';
  return `${topicSlug ?? 'default'}/concepts`;
}
