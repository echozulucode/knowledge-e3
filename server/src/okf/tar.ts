import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * Minimal, dependency-free `tar` (ustar) + gzip writer/reader for OKF bundle
 * downloads and uploads.
 *
 * OKF lists "tarball/zip" as a first-class distribution form, so a `.tar.gz` of the
 * concept files is a real, portable OKF bundle: extract it and `git init` to get the
 * git-of-record repo. We hand-roll ustar (rather than add a dependency) because the
 * format is small and we only ever handle regular files with short, known paths.
 *
 * A file's `content` may be a UTF-8 string (concepts, index, descriptor sidecars) or
 * raw bytes (image/PDF/attachment assets) — the archive is the *full-fidelity* export
 * form that carries binary assets, which the text-only JSON `{ files }` envelope cannot.
 */

interface ArchiveFile {
  path: string;
  /** UTF-8 text, or raw bytes for binary assets. */
  content: string | Uint8Array;
}

/** One regular file recovered from an archive. */
export interface ExtractedFile {
  path: string;
  bytes: Buffer;
}

/** Build a gzipped tar archive from a set of text and/or binary files. */
export function createTarGz(files: ArchiveFile[]): Buffer {
  return gzipSync(createTar(files));
}

/** Build an uncompressed ustar archive from a set of text and/or binary files. */
export function createTar(files: ArchiveFile[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const chunks: Buffer[] = [];
  for (const file of files) {
    const body =
      typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
    chunks.push(tarHeader(file.path, body.length, mtime));
    chunks.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  // Two 512-byte zero blocks mark end-of-archive.
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

/** Extract regular files from a gzipped ustar archive (the reverse of createTarGz). */
export function extractTarGz(archive: Buffer): ExtractedFile[] {
  return extractTar(gunzipSync(archive));
}

/**
 * Extract regular files from an uncompressed ustar archive. Only regular files
 * ('0' / '\0' typeflag) are returned; directory and other entries are skipped.
 * The ustar `prefix` field is rejoined with `name` so long paths round-trip.
 */
export function extractTar(buf: Buffer): ExtractedFile[] {
  const out: ExtractedFile[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // End-of-archive: a zero block.
    if (header.every((b) => b === 0)) break;
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    off += 512;
    const body = buf.subarray(off, off + size);
    off += size + ((512 - (size % 512)) % 512);
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path) out.push({ path, bytes: Buffer.from(body) });
    }
  }
  return out;
}

/** Read a NUL-terminated ustar string field. */
function readCString(buf: Buffer, offset: number, len: number): string {
  const slice = buf.subarray(offset, offset + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('utf8');
}

/** Parse a ustar octal numeric field (space/NUL padded). */
function readOctal(buf: Buffer, offset: number, len: number): number {
  const str = buf.subarray(offset, offset + len).toString('ascii').replace(/[\0 ]/g, '');
  return str ? parseInt(str, 8) : 0;
}

function tarHeader(path: string, size: number, mtime: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  const { name, prefix } = splitName(path);

  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(0o644, 8), 100); // mode
  buf.write(octal(0, 8), 108); // uid
  buf.write(octal(0, 8), 116); // gid
  buf.write(octal(size, 12), 124); // size
  buf.write(octal(mtime, 12), 136); // mtime
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder (8 spaces)
  buf.write('0', 156); // typeflag: regular file
  buf.write('ustar\0', 257, 6, 'utf8'); // magic
  buf.write('00', 263, 2, 'utf8'); // version
  if (prefix) buf.write(prefix, 345, 155, 'utf8');

  // Checksum = unsigned sum of all header bytes (with the field set to spaces),
  // written as 6 octal digits + NUL + space.
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

/** ustar numeric field: (len-1) octal digits, zero-padded, then a NUL. */
function octal(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}

/** Split a path into ustar name (≤100 bytes) + prefix (≤155 bytes). */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`path too long for tar (ustar) archive: ${path}`);
}
