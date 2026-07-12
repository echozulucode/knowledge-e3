import { gzipSync } from 'node:zlib';

/**
 * Minimal, dependency-free `tar` (ustar) + gzip writer for OKF bundle downloads.
 *
 * OKF lists "tarball/zip" as a first-class distribution form, so a `.tar.gz` of the
 * concept files is a real, portable OKF bundle: extract it and `git init` to get the
 * git-of-record repo. We hand-roll ustar (rather than add a dependency) because the
 * format is small and we only ever write regular files with short, known paths.
 */

interface ArchiveFile {
  path: string;
  content: string;
}

/** Build a gzipped tar archive from a set of UTF-8 text files. */
export function createTarGz(files: ArchiveFile[]): Buffer {
  return gzipSync(createTar(files));
}

/** Build an uncompressed ustar archive from a set of UTF-8 text files. */
export function createTar(files: ArchiveFile[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const chunks: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.content, 'utf8');
    chunks.push(tarHeader(file.path, body.length, mtime));
    chunks.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  // Two 512-byte zero blocks mark end-of-archive.
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
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
