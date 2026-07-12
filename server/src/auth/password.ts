/**
 * Password hashing for v0.1.
 *
 * Spec recommends argon2id; we ship scrypt for v0.1 because:
 *  1. node:crypto.scrypt is built-in (no native module compile).
 *  2. scrypt is FIPS-friendly and widely accepted.
 *  3. The hash format below is self-describing — when production swaps to
 *     argon2id, existing scrypt hashes can be detected and re-hashed on next
 *     login (graceful migration).
 *
 * Storage format: `scrypt$N$r$p$<salt-base64>$<hash-base64>`
 * Defaults: N=2^15 (32k), r=8, p=1, keyLen=64. Tunable in production.
 */
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify<string | Buffer, string | Buffer, number, { N: number; r: number; p: number; maxmem?: number }, Buffer>(
  scryptCb as never,
);

const PARAMS = { N: 1 << 15, r: 8, p: 1 } as const;
const KEYLEN = 64;
const SCHEME = 'scrypt';

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(plaintext, salt, KEYLEN, { ...PARAMS, maxmem: 64 * 1024 * 1024 });
  return [
    SCHEME,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;
  const N = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const computed = await scrypt(plaintext, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}
