import type { Knex } from 'knex';
import { fileTypeFromBuffer } from 'file-type';
import { env } from '../../config/env';
import { db, type Db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { decryptBuffer, encryptBuffer, hmac, safeEqual, sha256 } from '../../lib/crypto';
import { effectiveCompliance } from '../settings/settings.service';
import { newUuid } from '../../lib/ids';
import { newStorageKey, storage } from '../../lib/storage';
import type { RequestContext } from '../../http/context';
import { audit } from '../audit/audit.service';

/** Allowed upload types (sniffed from content, not trusted from the client). */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'application/pdf',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'text/plain',
  'text/csv',
]);

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

function looksLikeText(buf: Buffer) {
  const sample = buf.subarray(0, 4096);
  return !sample.includes(0);
}

export async function detectMime(buf: Buffer, originalName: string): Promise<string> {
  const sniffed = await fileTypeFromBuffer(buf);
  if (sniffed) {
    // Office files sniff as zip containers; trust the extension only within that family.
    if (sniffed.mime === 'application/zip' || sniffed.mime.startsWith('application/x-cfb')) {
      const ext = originalName.toLowerCase().split('.').pop();
      const office: Record<string, string> = {
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        doc: 'application/msword',
        xls: 'application/vnd.ms-excel',
      };
      if (ext && office[ext]) return office[ext];
    }
    return sniffed.mime;
  }
  if (looksLikeText(buf)) return originalName.toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/plain';
  return 'application/octet-stream';
}

export interface StoredFile {
  id: number;
  uuid: string;
  originalName: string;
  mime: string;
  size: number;
}

export async function storeFile(
  conn: Db,
  ctx: RequestContext,
  input: {
    buffer: Buffer;
    originalName: string;
    entity?: string | null;
    entityId?: number | null;
    imagesOnly?: boolean;
    isPublic?: boolean;
  },
): Promise<StoredFile> {
  if (input.buffer.length > env.UPLOAD_MAX_MB * 1024 * 1024)
    throw new AppError('PAYLOAD_TOO_LARGE', 'That file is too large');
  const mime = await detectMime(input.buffer, input.originalName);
  if (!ALLOWED_MIME.has(mime) || (input.imagesOnly && !IMAGE_MIME.has(mime))) {
    throw new AppError(
      'UNSUPPORTED_FILE_TYPE',
      input.imagesOnly ? 'Upload a PNG, JPEG, GIF, WebP or ICO image' : 'This file type is not allowed',
    );
  }
  const key = newStorageKey();
  // Public files (branding) are served to anyone, so encrypting them would add nothing.
  const sealed =
    !input.isPublic && (await effectiveCompliance()).encryptUploads ? encryptBuffer(input.buffer) : null;
  await storage.put(key, sealed ? sealed.data : input.buffer);
  // The bytes are written before the row commits: if the surrounding transaction rolls back,
  // delete them so no orphaned file is left in storage.
  const tx = conn as Partial<Knex.Transaction>;
  if (tx.isTransaction && tx.executionPromise)
    tx.executionPromise.catch(() => storage.delete(key).catch(() => undefined));
  const uuid = newUuid();
  const safeName = input.originalName.replace(/[\r\n"\\/]/g, '_').slice(0, 255) || 'file';
  const [id] = await conn('files').insert({
    uuid,
    entity: input.entity ?? null,
    entity_id: input.entityId ?? null,
    original_name: safeName,
    storage_key: key,
    mime,
    size: input.buffer.length,
    sha256: sha256(input.buffer),
    is_public: input.isPublic ?? false,
    uploaded_by: ctx.user?.id ?? null,
    enc_kid: sealed?.kid ?? null,
  });
  await audit(conn, ctx, {
    action: 'file.uploaded',
    entity: input.entity ?? 'file',
    entityId: input.entityId ?? id,
    diff: { file: uuid, name: safeName, mime },
  });
  return { id: id!, uuid, originalName: safeName, mime, size: input.buffer.length };
}

/** The file's bytes as uploaded (decrypted when stored encrypted). */
export async function readStoredFile(file: {
  storage_key: string;
  enc_kid?: string | null;
}): Promise<Buffer> {
  const data = await storage.get(file.storage_key);
  return file.enc_kid ? decryptBuffer(data) : data;
}

/** Signed, expiring download token: base64url(uuid.exp).sig */
export function signFileUrl(uuid: string, ttlSeconds = 300): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(`${uuid}.${exp}`).toString('base64url');
  return `/api/v1/files/download?token=${payload}.${hmac(env.FILE_URL_SECRET, payload)}`;
}

export function verifyFileToken(token: string): string {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(env.FILE_URL_SECRET, payload)))
    throw new AppError('FORBIDDEN', 'This link is not valid');
  const [uuid, exp] = Buffer.from(payload, 'base64url').toString().split('.');
  if (!uuid || !exp || Number(exp) < Date.now() / 1000)
    throw new AppError('FORBIDDEN', 'This link has expired');
  return uuid;
}

export async function getFileRow(uuid: string, conn: Db = db) {
  const row = await conn('files').where({ uuid }).whereNull('deleted_at').first();
  if (!row) throw notFound('File');
  return row;
}

export const fileDto = (r: {
  uuid: string;
  original_name: string;
  mime: string;
  size: number;
  created_at: Date;
  uploaded_by: number | null;
}) => ({
  uuid: r.uuid,
  name: r.original_name,
  mime: r.mime,
  size: Number(r.size),
  createdAt: new Date(r.created_at).toISOString(),
});
