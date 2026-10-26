import { systemContext } from '../../http/context';
import { db } from '../../db/knex';
import { logger } from '../../lib/logger';
import { activeKid, decrypt, decryptBuffer, encrypt, encryptBuffer, isCurrent } from '../../lib/crypto';
import { newStorageKey, storage } from '../../lib/storage';
import { audit } from '../audit/audit.service';
import { ENTITY_TABLE } from '../custom-fields/definitions';

const ENC = 'enc:';

export interface RotationReport {
  /** Values or files re-encrypted, by area. */
  done: Record<string, number>;
  /** Rows or files that could not be processed (left as they were), by area. */
  failed: Record<string, number>;
  /** Old file bytes that could not be removed after re-encryption. */
  leftovers: string[];
}

const newReport = (): RotationReport => ({ done: {}, failed: {}, leftovers: [] });
const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

/**
 * Write the new bytes under a new key, point the row at them, then remove the old bytes.
 * A crash at any point leaves the row and its bytes consistent.
 */
async function replaceFile(
  f: { id: number; storage_key: string },
  data: Buffer,
  kid: string,
  report: RotationReport,
) {
  const key = newStorageKey();
  await storage.put(key, data);
  await db('files').where({ id: f.id }).update({ storage_key: key, enc_kid: kid });
  try {
    await storage.delete(f.storage_key);
  } catch (err) {
    // Plain or old-key bytes are still on disk: say so, an operator must remove them.
    logger.error({ err, key: f.storage_key }, 'could not remove the old copy of a re-encrypted file');
    report.leftovers.push(f.storage_key);
  }
}

/** Columns holding a single encrypted string. */
const SECRET_COLUMNS: [table: string, column: string][] = [
  ['users', 'totp_secret_enc'],
  ['webhooks', 'secret_enc'],
  ['mail_accounts', 'password_enc'],
];

/**
 * Re-encrypt everything under the active key (the first in ENCRYPTION_KEYS): secrets, sensitive
 * custom field values and encrypted files. Safe while the app runs: each row is re-read under a
 * lock and only rewritten if it still needs it. Keep old keys in the ring until this finishes.
 */
export async function rotateKeys(): Promise<RotationReport> {
  const report = newReport();

  for (const [table, column] of SECRET_COLUMNS) {
    const area = `${table}.${column}`;
    for (const { id } of await db(table).whereNotNull(column).select('id')) {
      try {
        await db.transaction(async (trx) => {
          const row = await trx(table).where({ id }).forUpdate().first(column);
          const value = row?.[column] as string | null | undefined;
          if (!value || isCurrent(value)) return;
          await trx(table)
            .where({ id })
            .update({ [column]: encrypt(decrypt(value)) });
          bump(report.done, area);
        });
      } catch (err) {
        logger.error({ err, table, id }, 'could not re-encrypt a secret');
        bump(report.failed, area);
      }
    }
  }

  for (const table of new Set(Object.values(ENTITY_TABLE))) {
    const area = `${table}.custom`;
    for (const { id } of await db(table).where('custom', 'like', `%"${ENC}%`).select('id')) {
      try {
        await db.transaction(async (trx) => {
          const row = await trx(table).where({ id }).forUpdate().first('custom', 'updated_at');
          const custom = (row?.custom ?? {}) as Record<string, unknown>;
          let changed = false;
          for (const [k, v] of Object.entries(custom)) {
            if (typeof v === 'string' && v.startsWith(ENC) && !isCurrent(v.slice(ENC.length))) {
              custom[k] = `${ENC}${encrypt(decrypt(v.slice(ENC.length)))}`;
              changed = true;
            }
          }
          if (!changed) return;
          // Keep updated_at: re-encryption is not an edit (retention rules look at it).
          await trx(table)
            .where({ id })
            .update({ custom: JSON.stringify(custom), updated_at: row!.updated_at });
          bump(report.done, area);
        });
      } catch (err) {
        logger.error({ err, table, id }, 'could not re-encrypt custom values');
        bump(report.failed, area);
      }
    }
  }

  for (const f of await db('files').whereNotNull('enc_kid').whereNot('enc_kid', activeKid())) {
    try {
      const sealed = encryptBuffer(decryptBuffer(await storage.get(f.storage_key)));
      await replaceFile(f, sealed.data, sealed.kid, report);
      bump(report.done, 'files');
    } catch (err) {
      logger.error({ err, file: f.uuid }, 'could not re-encrypt a file');
      bump(report.failed, 'files');
    }
  }

  await audit(db, systemContext('cli'), {
    action: 'security.keys_rotated',
    entity: 'security',
    diff: { ...report },
  });
  return report;
}

/** Encrypt files stored before upload encryption was turned on (public branding files stay as they are). */
export async function encryptExistingFiles(): Promise<RotationReport> {
  const report = newReport();
  for (const f of await db('files').whereNull('enc_kid').where({ is_public: false })) {
    try {
      const sealed = encryptBuffer(await storage.get(f.storage_key));
      await replaceFile(f, sealed.data, sealed.kid, report);
      bump(report.done, 'files');
    } catch (err) {
      logger.error({ err, file: f.uuid }, 'could not encrypt a file');
      bump(report.failed, 'files');
    }
  }
  await audit(db, systemContext('cli'), {
    action: 'security.files_encrypted',
    entity: 'security',
    diff: { ...report },
  });
  return report;
}
