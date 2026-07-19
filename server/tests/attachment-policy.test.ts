import { describe, it, expect } from 'vitest';
import {
  resolveAttachmentType,
  sanitizeFilename,
  dispositionFor,
} from '../src/images/attachment-policy.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
const PDF = Buffer.from('%PDF-1.7\n...');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe('attachment policy', () => {
  it('detects images by signature regardless of claimed type', () => {
    expect(resolveAttachmentType(PNG, 'application/octet-stream', 'x.bin').type?.mime).toBe('image/png');
    expect(resolveAttachmentType(JPEG, '', undefined).type?.mime).toBe('image/jpeg');
    expect(resolveAttachmentType(GIF, '', undefined).type?.mime).toBe('image/gif');
    expect(resolveAttachmentType(WEBP, '', undefined).type?.mime).toBe('image/webp');
  });

  it('accepts PDF and zip as downloads by signature', () => {
    const pdf = resolveAttachmentType(PDF, 'application/pdf', 'paper.pdf');
    expect(pdf.ok).toBe(true);
    expect(pdf.type).toMatchObject({ mime: 'application/pdf', disposition: 'download' });

    const zip = resolveAttachmentType(ZIP, 'application/zip', 'data.zip');
    expect(zip.type).toMatchObject({ mime: 'application/zip', category: 'archive', disposition: 'download' });
  });

  it('content wins over a lying Content-Type', () => {
    // Claims to be a PNG, is actually a PDF → stored as a (download) PDF.
    expect(resolveAttachmentType(PDF, 'image/png', 'trick.png').type?.mime).toBe('application/pdf');
  });

  it('refuses an inline image whose bytes are not that image', () => {
    const r = resolveAttachmentType(Buffer.from('<html>nope'), 'image/png', 'evil.png');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not match|unsupported/);
  });

  it('accepts SVG only when it looks like SVG, always as a download', () => {
    const ok = resolveAttachmentType(SVG, 'image/svg+xml', 'logo.svg');
    expect(ok.ok).toBe(true);
    expect(ok.type?.disposition).toBe('download'); // never inline — SVG can carry script
    const bad = resolveAttachmentType(Buffer.from('just text'), 'image/svg+xml', 'x.svg');
    expect(bad.ok).toBe(false);
  });

  it('accepts text data types by declared mime / extension', () => {
    expect(resolveAttachmentType(Buffer.from('a,b,c'), 'text/csv', 'd.csv').type?.mime).toBe('text/csv');
    expect(resolveAttachmentType(Buffer.from('{}'), 'application/json', 'd.json').type?.mime).toBe('application/json');
    // Resolvable by extension when the mime is generic.
    expect(resolveAttachmentType(Buffer.from('hello'), 'application/octet-stream', 'notes.txt').type?.mime).toBe('text/plain');
  });

  it('rejects off-allowlist types and empty uploads', () => {
    expect(resolveAttachmentType(Buffer.from('MZ...'), 'application/x-msdownload', 'a.exe').ok).toBe(false);
    expect(resolveAttachmentType(Buffer.alloc(0), 'image/png', 'x.png').ok).toBe(false);
  });

  it('enforces per-type size caps', () => {
    const bigSvg = Buffer.concat([Buffer.from('<svg>'), Buffer.alloc(3 * 1024 * 1024, 0x20)]);
    const r = resolveAttachmentType(bigSvg, 'image/svg+xml', 'huge.svg');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds/);
  });

  it('maps disposition from a stored mime', () => {
    expect(dispositionFor('image/png')).toBe('inline');
    expect(dispositionFor('application/pdf')).toBe('download');
    expect(dispositionFor('image/svg+xml')).toBe('download');
    expect(dispositionFor('application/octet-stream')).toBe('download'); // unknown → safe default
  });

  it('sanitizes filenames: strips path, control chars, and quotes', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('a"b.pdf')).toBe('ab.pdf');
    expect(sanitizeFilename('line\nbreak.csv')).toBe('linebreak.csv');
    expect(sanitizeFilename('   ')).toBeNull();
    expect(sanitizeFilename(undefined)).toBeNull();
  });
});
