import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

interface Key {
  kid: string;
  key: Buffer;
}

let ring: Key[] | null = null;

/** The key ring: the first key encrypts, every key decrypts. */
export function keyRing(): Key[] {
  ring ??= env.ENCRYPTION_KEYS
    ? env.ENCRYPTION_KEYS.split(',').map((entry) => {
        const [kid, hex] = entry.split(':');
        return { kid: kid!, key: Buffer.from(hex!, 'hex') };
      })
    : [{ kid: 'k0', key: Buffer.from(env.ENCRYPTION_KEY, 'hex') }];
  return ring;
}

/** Tests only: forget the cached ring after changing env. */
export function resetKeyRing() {
  ring = null;
}

export const activeKid = () => keyRing()[0]!.kid;

function keyFor(kid: string): Buffer {
  const k = keyRing().find((r) => r.kid === kid);
  if (!k) throw new Error(`Encryption key "${kid}" is not in the key ring`);
  return k.key;
}

const ZERO_KEY = '0'.repeat(64);

/**
 * Ciphertext written before the key ring had no key id; it was always ENCRYPTION_KEY. The all-zero
 * development default is never accepted once a real key ring exists (anyone could forge it).
 */
function legacyKeys(): Buffer[] {
  const keys = keyRing().map((k) => k.key);
  if (env.ENCRYPTION_KEY === ZERO_KEY && env.ENCRYPTION_KEYS) return keys;
  const legacy = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  return [legacy, ...keys.filter((k) => !k.equals(legacy))];
}

/**
 * AES-256-GCM. Output: `v1.<kid>.<iv>.<tag>.<ciphertext>` (base64url parts).
 * `aad` names where the value belongs (for example `custom:contact:diagnosis` or a user id): it is
 * authenticated but not stored, so a ciphertext copied to another field or row fails to decrypt.
 */
export function encrypt(plain: string, aad = ''): string {
  const { kid, key } = keyRing()[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', kid, ...[iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url'))].join('.');
}

function open(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer, aad?: string): Buffer {
  // Full-length tags only: a truncated tag would weaken forgery resistance.
  if (tag.length !== 16) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Decrypt with the same `aad` used to encrypt. Pre-ring ciphertext (no key id) carries no binding. */
export function decrypt(payload: string, aad = ''): string {
  const parts = payload.split('.');
  const b = (s: string) => Buffer.from(s, 'base64url');
  if (parts[0] === 'v1' && parts.length === 5) {
    const [, kid, iv, tag, data] = parts as [string, string, string, string, string];
    return open(keyFor(kid), b(iv), b(tag), b(data), aad).toString('utf8');
  }
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !data || parts.length !== 3) throw new Error('Malformed ciphertext');
  for (const key of legacyKeys()) {
    try {
      return open(key, iv, tag, data).toString('utf8');
    } catch {
      // try the next key
    }
  }
  throw new Error('Cannot decrypt: no key in the ring matches');
}

/** Whether a ciphertext is in the current format with the active key (rotation redoes the rest). */
export function isCurrent(payload: string): boolean {
  const parts = payload.split('.');
  return parts[0] === 'v1' && parts[1] === activeKid();
}

const MAGIC = Buffer.from('ENC1');

/**
 * Encrypt bytes (files). Layout: ENC1 | kid length | kid | iv(12) | tag(16) | ciphertext.
 * `aad` binds the bytes to their file (its uuid).
 */
export function encryptBuffer(plain: Buffer, aad = ''): { data: Buffer; kid: string } {
  const { kid, key } = keyRing()[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const kidBuf = Buffer.from(kid);
  return {
    data: Buffer.concat([MAGIC, Buffer.from([kidBuf.length]), kidBuf, iv, cipher.getAuthTag(), body]),
    kid,
  };
}

export function decryptBuffer(data: Buffer, aad = ''): Buffer {
  if (!data.subarray(0, 4).equals(MAGIC)) throw new Error('Not an encrypted file');
  const len = data[4]!;
  const kid = data.subarray(5, 5 + len).toString();
  const at = 5 + len;
  return open(
    keyFor(kid),
    data.subarray(at, at + 12),
    data.subarray(at + 12, at + 28),
    data.subarray(at + 28),
    aad,
  );
}
