import { systemContext } from '../../http/context';
import { db } from '../../db/knex';
import { logger } from '../../lib/logger';
import { activeKid, decrypt, decryptBuffer, encrypt, encryptBuffer, isCurrent } from '../../lib/crypto';
import { newStorageKey, storage } from '../../lib/storage';
import { audit } from '../audit/audit.service';
import { allCustomEntities, entityTable } from '../custom-fields/definitions';
import { reencryptValue } from '../records/custom';
import { totpAad } from '../auth/auth.service';
import { fileAad } from '../files/files.service';
import { getModule } from '../../modules/registry';
import { clearModuleSettingsCache, secretAad } from '../../modules/module-settings';

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

/** Columns holding a single encrypted string, with the binding each value is encrypted with. */
const SECRET_COLUMNS: [table: string, column: string, aad: (id: number) => string][] = [
  ['users', 'totp_secret_enc', totpAad],
  ['webhooks', 'secret_enc', () => 'webhooks.secret_enc'],
  ['mail_accounts', 'password_enc', () => 'mail_accounts.password_enc'],
  ['mail_accounts', 'access_token_enc', () => 'mail_accounts.access_token_enc'],
  ['mail_accounts', 'refresh_token_enc', () => 'mail_accounts.refresh_token_enc'],
  ['push_vapid', 'private_key_enc', () => 'push_vapid.private_key_enc'],
  // Module tables exist only once the module has been enabled.
  ['m_assistant_config', 'api_key_enc', () => 'm_assistant_config.api_key_enc'],
];

/**
 * Re-encrypt everything under the active key (the first in ENCRYPTION_KEYS): secrets, sensitive
 * custom field values and encrypted files. Safe while the app runs: each row is re-read under a
 * lock and only rewritten if it still needs it. Keep old keys in the ring until this finishes.
 */
export async function rotateKeys(): Promise<RotationReport> {
  const report = newReport();

  for (const [table, column, aadFor] of SECRET_COLUMNS) {
    const area = `${table}.${column}`;
    if (!(await db.schema.hasTable(table))) continue;
    for (const { id } of await db(table).whereNotNull(column).select('id')) {
      try {
        await db.transaction(async (trx) => {
          const row = await trx(table).where({ id }).forUpdate().first(column);
          const value = row?.[column] as string | null | undefined;
          if (!value || isCurrent(value)) return;
          await trx(table)
            .where({ id })
            .update({ [column]: encrypt(decrypt(value, aadFor(id)), aadFor(id)) });
          bump(report.done, area);
        });
      } catch (err) {
        logger.error({ err, table, id }, 'could not re-encrypt a secret');
        bump(report.failed, area);
      }
    }
  }

  // Module settings: secret fields inside the settings JSON.
  for (const { module_key: key } of await db('module_states').whereNotNull('settings').select('module_key')) {
    const secrets = (getModule(key as string)?.manifest.settings ?? []).filter((f) => f.type === 'secret');
    if (!secrets.length) continue;
    try {
      await db.transaction(async (trx) => {
        const row = await trx('module_states').where({ module_key: key }).forUpdate().first('settings');
        const raw: unknown = row?.settings;
        const values = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as Record<string, unknown>;
        let changed = false;
        for (const f of secrets) {
          const v = values[f.key];
          if (typeof v !== 'string' || isCurrent(v)) continue;
          values[f.key] = encrypt(
            decrypt(v, secretAad(key as string, f.key)),
            secretAad(key as string, f.key),
          );
          changed = true;
        }
        if (!changed) return;
        await trx('module_states')
          .where({ module_key: key })
          .update({ settings: JSON.stringify(values) });
        bump(report.done, 'module_states.settings');
      });
    } catch (err) {
      logger.error({ err, module: key }, 'could not re-encrypt module settings');
      bump(report.failed, 'module_states.settings');
    }
  }
  clearModuleSettingsCache();

  for (const entity of allCustomEntities()) {
    const table = entityTable(entity);
    if (!(await db.schema.hasTable(table))) continue;
    const area = `${table}.custom`;
    for (const { id } of await db(table).where('custom', 'like', `%"${ENC}%`).select('id')) {
      try {
        await db.transaction(async (trx) => {
          const row = await trx(table).where({ id }).forUpdate().first('custom', 'updated_at');
          const custom = (row?.custom ?? {}) as Record<string, unknown>;
          let changed = false;
          for (const [k, v] of Object.entries(custom)) {
            if (typeof v === 'string' && v.startsWith(ENC) && !isCurrent(v.slice(ENC.length))) {
              custom[k] = reencryptValue(v, entity, k);
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
      const aad = fileAad(f.uuid as string);
      const sealed = encryptBuffer(decryptBuffer(await storage.get(f.storage_key), aad), aad);
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
      const sealed = encryptBuffer(await storage.get(f.storage_key), fileAad(f.uuid as string));
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
