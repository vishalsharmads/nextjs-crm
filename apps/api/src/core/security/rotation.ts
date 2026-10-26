import { systemContext } from '../../http/context';
import { db } from '../../db/knex';
import { activeKid, decrypt, decryptBuffer, encrypt, encryptBuffer, isCurrent } from '../../lib/crypto';
import { newStorageKey, storage } from '../../lib/storage';

/**
 * Write the new bytes under a new key, point the row at them, then remove the old bytes.
 * A crash at any point leaves the row and its bytes consistent.
 */
async function replaceFile(f: { id: number; storage_key: string }, data: Buffer, kid: string) {
  const key = newStorageKey();
  await storage.put(key, data);
  await db('files').where({ id: f.id }).update({ storage_key: key, enc_kid: kid });
  await storage.delete(f.storage_key).catch(() => undefined);
}
import { audit } from '../audit/audit.service';
import { ENTITY_TABLE } from '../custom-fields/definitions';

const ENC = 'enc:';

/** Columns holding a single encrypted string. */
const SECRET_COLUMNS: [table: string, column: string][] = [
  ['users', 'totp_secret_enc'],
  ['webhooks', 'secret_enc'],
  ['mail_accounts', 'password_enc'],
];

/**
 * Re-encrypt everything under the active key (the first in ENCRYPTION_KEYS): secrets, sensitive
 * custom field values and encrypted files. Keep the old keys in the ring until this finishes.
 */
export async function rotateKeys(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const [table, column] of SECRET_COLUMNS) {
    let n = 0;
    const rows = await db(table).whereNotNull(column).select('id', column);
    for (const r of rows) {
      const value = r[column] as string;
      if (isCurrent(value)) continue;
      await db(table)
        .where({ id: r.id })
        .update({ [column]: encrypt(decrypt(value)) });
      n++;
    }
    counts[`${table}.${column}`] = n;
  }

  for (const table of new Set(Object.values(ENTITY_TABLE))) {
    let n = 0;
    const rows = await db(table).where('custom', 'like', `%"${ENC}%`).select('id', 'custom', 'updated_at');
    for (const r of rows) {
      const custom = r.custom as Record<string, unknown>;
      let changed = false;
      for (const [k, v] of Object.entries(custom)) {
        if (typeof v === 'string' && v.startsWith(ENC) && !isCurrent(v.slice(ENC.length))) {
          custom[k] = `${ENC}${encrypt(decrypt(v.slice(ENC.length)))}`;
          changed = true;
        }
      }
      if (!changed) continue;
      // Keep updated_at: re-encryption is not an edit (retention rules look at it).
      await db(table)
        .where({ id: r.id })
        .update({ custom: JSON.stringify(custom), updated_at: r.updated_at });
      n++;
    }
    counts[`${table}.custom`] = n;
  }

  let files = 0;
  for (const f of await db('files').whereNotNull('enc_kid').whereNot('enc_kid', activeKid())) {
    const sealed = encryptBuffer(decryptBuffer(await storage.get(f.storage_key)));
    await replaceFile(f, sealed.data, sealed.kid);
    files++;
  }
  counts.files = files;

  await audit(db, systemContext('cli'), {
    action: 'security.keys_rotated',
    entity: 'security',
    diff: counts,
  });
  return counts;
}

/** Encrypt files stored before upload encryption was turned on (public branding files stay as they are). */
export async function encryptExistingFiles(): Promise<number> {
  let n = 0;
  for (const f of await db('files').whereNull('enc_kid').where({ is_public: false })) {
    const sealed = encryptBuffer(await storage.get(f.storage_key));
    await replaceFile(f, sealed.data, sealed.kid);
    n++;
  }
  await audit(db, systemContext('cli'), {
    action: 'security.files_encrypted',
    entity: 'security',
    diff: { files: n },
  });
  return n;
}
