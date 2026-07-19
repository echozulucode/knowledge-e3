/**
 * Upload governance for attachments (ADR-0003 §7, OWASP file-upload guidance).
 *
 * The rules, in one place so they are testable and hard to bypass:
 *  - Allowlist by category; anything else is rejected.
 *  - Detect the REAL type from magic bytes; never trust the client Content-Type.
 *  - An INLINE-rendered type (images) MUST match a binary signature — that is the
 *    check that stops a script-bearing file being served inline as an "image".
 *  - Everything else is served as a DOWNLOAD with `nosniff`, so a mislabelled or
 *    active-content payload cannot execute in the page.
 *  - SVG is download-only (it can carry <script>); archives are opaque, never
 *    unpacked (sidesteps zip bombs / Zip-Slip).
 *  - Per-type size caps, all under the 25 MB raw-body ceiling (larger needs the
 *    streaming-upload change — see ADR open items).
 */

export type AttachmentCategory = 'image' | 'document' | 'data' | 'archive';
export type AttachmentDisposition = 'inline' | 'download';

export interface AttachmentType {
  mime: string;
  ext: string;
  category: AttachmentCategory;
  /** How it is served: inline (browser renders) or download (Content-Disposition). */
  disposition: AttachmentDisposition;
  maxBytes: number;
  /**
   * Leading-byte signatures (any match). Empty for text types that have no
   * reliable magic; those are accepted only because they are download-only.
   */
  signatures: number[][];
}

const MB = 1024 * 1024;

/** The allowlist. Order matters only for readability; lookup is by detection. */
const TYPES: AttachmentType[] = [
  { mime: 'image/png', ext: 'png', category: 'image', disposition: 'inline', maxBytes: 10 * MB, signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  { mime: 'image/jpeg', ext: 'jpg', category: 'image', disposition: 'inline', maxBytes: 10 * MB, signatures: [[0xff, 0xd8, 0xff]] },
  { mime: 'image/gif', ext: 'gif', category: 'image', disposition: 'inline', maxBytes: 10 * MB, signatures: [[0x47, 0x49, 0x46, 0x38]] },
  { mime: 'image/webp', ext: 'webp', category: 'image', disposition: 'inline', maxBytes: 10 * MB, signatures: [] /* RIFF….WEBP, checked specially */ },
  { mime: 'application/pdf', ext: 'pdf', category: 'document', disposition: 'download', maxBytes: 25 * MB, signatures: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
  // Zip family: local file header, empty archive, spanned. Opaque download only.
  { mime: 'application/zip', ext: 'zip', category: 'archive', disposition: 'download', maxBytes: 25 * MB, signatures: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]] },
  // Text/vector types: no reliable binary signature; safe ONLY because download-only.
  { mime: 'image/svg+xml', ext: 'svg', category: 'image', disposition: 'download', maxBytes: 2 * MB, signatures: [] },
  { mime: 'text/csv', ext: 'csv', category: 'data', disposition: 'download', maxBytes: 10 * MB, signatures: [] },
  { mime: 'application/json', ext: 'json', category: 'data', disposition: 'download', maxBytes: 10 * MB, signatures: [] },
  { mime: 'text/plain', ext: 'txt', category: 'data', disposition: 'download', maxBytes: 10 * MB, signatures: [] },
];

const BY_MIME = new Map(TYPES.map((t) => [t.mime, t]));
const BY_EXT = new Map(TYPES.map((t) => [t.ext, t]));
/** MIME aliases a client might send for an allowed type. */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'application/x-zip-compressed': 'application/zip',
  'text/json': 'application/json',
};

export interface AttachmentResolution {
  ok: boolean;
  type?: AttachmentType;
  reason?: string;
}

function startsWith(bytes: Buffer, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (bytes[i] !== sig[i]) return false;
  return true;
}

function isWebp(bytes: Buffer): boolean {
  // RIFF <size> WEBP
  return (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}

/** A binary type detected purely from content, ignoring any claimed type. */
function detectBinary(bytes: Buffer): AttachmentType | undefined {
  if (isWebp(bytes)) return BY_MIME.get('image/webp');
  for (const t of TYPES) {
    if (t.signatures.length === 0) continue;
    if (t.signatures.some((sig) => startsWith(bytes, sig))) return t;
  }
  return undefined;
}

function normalizeMime(mime: string | undefined): string {
  const m = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return MIME_ALIASES[m] ?? m;
}

function extOf(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : undefined;
}

/**
 * Decide whether an upload is allowed and, if so, its canonical type — resolved
 * from CONTENT first, then declared MIME, then filename extension.
 */
export function resolveAttachmentType(
  bytes: Buffer,
  declaredMime: string | undefined,
  filename: string | undefined,
): AttachmentResolution {
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'empty upload' };

  // 1) Content wins: a real signature is authoritative regardless of the label.
  const detected = detectBinary(bytes);
  if (detected) {
    if (bytes.length > detected.maxBytes) return tooLarge(detected);
    return { ok: true, type: detected };
  }

  // 2) No binary signature → only the text/vector allowlist can apply, and only
  //    as a download. Resolve by declared MIME then extension.
  const candidate = BY_MIME.get(normalizeMime(declaredMime)) ?? BY_EXT.get(extOf(filename) ?? '');
  if (!candidate) {
    return { ok: false, reason: 'unsupported or unrecognized file type' };
  }
  // An inline (image) type with no detectable signature is a mismatch — e.g. a
  // file claiming image/png whose bytes are not a PNG. Refuse; never inline it.
  if (candidate.disposition === 'inline') {
    return { ok: false, reason: `content does not match ${candidate.mime}` };
  }
  if (candidate.mime === 'image/svg+xml' && !looksLikeSvg(bytes)) {
    return { ok: false, reason: 'not a valid SVG document' };
  }
  if (bytes.length > candidate.maxBytes) return tooLarge(candidate);
  return { ok: true, type: candidate };
}

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 1024)).toLowerCase();
  return head.includes('<svg');
}

function tooLarge(t: AttachmentType): AttachmentResolution {
  return { ok: false, reason: `file exceeds the ${Math.round(t.maxBytes / MB)} MB limit for ${t.mime}` };
}

/**
 * Sanitize a client-supplied filename for use in Content-Disposition and UI.
 * Strips any path, control chars, and quotes; caps length. Never used as the
 * stored name (that stays content-addressed) — only as display metadata.
 */
export function sanitizeFilename(name: string | undefined): string | null {
  if (!name) return null;
  // Strip any directory path, then drop control chars (code < 0x20) and the
  // double-quote (which would break the Content-Disposition header). Char-code
  // filtering avoids fragile control-char regex escaping.
  const noPath = name.replace(/^.*[\\/]/, '');
  let clean = '';
  for (const ch of noPath) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || ch === '"') continue;
    clean += ch;
  }
  clean = clean.trim();
  if (!clean || clean === '.' || clean === '..') return null;
  return clean.slice(0, 200);
}

/** Content-Type serving disposition for a stored MIME (defaults to download). */
export function dispositionFor(mime: string): AttachmentDisposition {
  return BY_MIME.get(normalizeMime(mime))?.disposition ?? 'download';
}
