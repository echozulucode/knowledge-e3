/**
 * Per-asset sidecar descriptor — the git-tracked source of truth for an asset's
 * identity and resolution (ADR-0003).
 *
 * One descriptor file sits beside (or, for off-git bytes, still within) the
 * bundle's `assets/` directory as `<file>.meta.json`. Assets are content-
 * addressed and immutable, so each descriptor is write-once and can never
 * merge-conflict — even across concurrent edits or multi-repo pulls. The SQLite
 * `images` table is a derived cache of these; dropping it and rebuilding must
 * recover identical rows from the sidecars alone, which is what keeps the
 * database disposable even when the bytes live off-git.
 */

/** Sidecar filename suffix. Distinct from any asset extension so it never
 *  collides with a stored asset (asset names are `<sha16>.<singleext>`). */
export const DESCRIPTOR_SUFFIX = '.meta.json';

/** How an asset entered the system — see ADR-0003 provenance classes. */
export type AssetProvenance = 'git-native' | 'uploaded' | 'external';

export interface AssetDescriptor {
  /** Bump when the on-disk shape changes; readers tolerate older versions. */
  schema_version: 1;
  /** Bundle-relative bytes filename, e.g. `a1b2c3d4e5f6a7b8.png`. The logical id. */
  file: string;
  /** Full content digest (the `file` stem is its 16-char prefix). */
  sha256: string;
  mime: string;
  byte_size: number;
  /** Human-facing name for downloads; the stored `file` is opaque. */
  original_filename: string | null;
  /** Alt text for images. */
  alt: string | null;
  provenance: AssetProvenance;
  created_at: string;
  /** User id that created it, for provenance. Not guaranteed to exist on a
   *  foreign instance — the rebuild resolves it to a known user before use. */
  created_by: string;
}

export function descriptorSidecarName(file: string): string {
  return `${file}${DESCRIPTOR_SUFFIX}`;
}

export function isDescriptorSidecar(name: string): boolean {
  return name.endsWith(DESCRIPTOR_SUFFIX);
}

export function serializeDescriptor(d: AssetDescriptor): string {
  // Stable key order + trailing newline so re-writing identical content produces
  // a byte-identical file (no spurious git diffs).
  const ordered: AssetDescriptor = {
    schema_version: 1,
    file: d.file,
    sha256: d.sha256,
    mime: d.mime,
    byte_size: d.byte_size,
    original_filename: d.original_filename,
    alt: d.alt,
    provenance: d.provenance,
    created_at: d.created_at,
    created_by: d.created_by,
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** Parse a sidecar. Returns null if it is malformed or missing required fields,
 *  so a single corrupt sidecar can be skipped rather than failing a rebuild. */
export function parseDescriptor(json: string): AssetDescriptor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['file'] !== 'string' || typeof r['sha256'] !== 'string') return null;
  if (typeof r['mime'] !== 'string' || typeof r['byte_size'] !== 'number') return null;
  const provenance = r['provenance'];
  return {
    schema_version: 1,
    file: r['file'],
    sha256: r['sha256'],
    mime: r['mime'],
    byte_size: r['byte_size'],
    original_filename: typeof r['original_filename'] === 'string' ? r['original_filename'] : null,
    alt: typeof r['alt'] === 'string' ? r['alt'] : null,
    provenance:
      provenance === 'git-native' || provenance === 'uploaded' || provenance === 'external'
        ? provenance
        : 'uploaded',
    created_at: typeof r['created_at'] === 'string' ? r['created_at'] : new Date(0).toISOString(),
    created_by: typeof r['created_by'] === 'string' ? r['created_by'] : '',
  };
}
