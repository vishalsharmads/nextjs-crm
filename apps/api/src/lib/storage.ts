import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '../config/env';
import { randomToken } from './crypto';

/** Storage driver contract. Local disk now; an S3-compatible driver can implement the same interface. */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Readable;
  delete(key: string): Promise<void>;
}

const root = () => path.resolve(env.STORAGE_DIR);

function resolveKey(key: string) {
  if (!/^[a-zA-Z0-9_-]{2}\/[a-zA-Z0-9_-]{20,}$/.test(key)) throw new Error('Invalid storage key');
  return path.join(root(), key);
}

export const localStorageDriver: StorageDriver = {
  async put(key, data) {
    const p = resolveKey(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
  },
  get: (key) => readFile(resolveKey(key)),
  stream: (key) => createReadStream(resolveKey(key)),
  async delete(key) {
    await rm(resolveKey(key), { force: true });
  },
};

export const storage: StorageDriver = localStorageDriver;

/** Random, non-guessable key; never derived from the original filename. */
export function newStorageKey(): string {
  const token = randomToken(24);
  return `${token.slice(0, 2)}/${token}`;
}
