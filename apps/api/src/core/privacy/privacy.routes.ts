import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { hmac } from '../../lib/crypto';
import { env } from '../../config/env';
import { storage } from '../../lib/storage';
import { audit } from '../audit/audit.service';
import { daysOf, resealDays } from '../audit/integrity';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';

const PERSONAL = ['contact', 'lead'] as const;
const params = z.object({ entity: z.enum(PERSONAL), uuid: z.uuid() });

/** PII columns blanked by anonymization (structure and history stay for reporting). */
const PII: Record<(typeof PERSONAL)[number], Record<string, string | null>> = {
  contact: {
    first_name: 'Anonymized',
    last_name: '',
    email: null,
    phone: null,
    phone_e164: null,
    job_title: null,
    avatar_file_uuid: null,
  },
  lead: {
    first_name: 'Anonymized',
    last_name: '',
    email: null,
    phone: null,
    phone_e164: null,
    company_name: null,
    job_title: null,
  },
};

/** Confirmation token so a hard delete needs two deliberate calls (preview, then confirm). */
const confirmToken = (entity: string, uuid: string) =>
  hmac(env.CSRF_SECRET, `hard-delete:${entity}:${uuid}`).slice(0, 16);

/**
 * Remove personal data from audit diffs for one record. This is the only sanctioned
 * modification of audit_logs (privacy law outranks immutability, decision D6); the
 * session flag opens the trigger, and the redaction itself is audited.
 */
async function redactAudit(
  trx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  entity: string,
  id: number,
) {
  const days = await daysOf(trx, 'audit', { entity, entity_id: id });
  await trx.raw('SET @audit_redaction = 1');
  try {
    await trx('audit_logs')
      .where({ entity, entity_id: id })
      .update({ diff: JSON.stringify({ redacted: true }), ip: null, user_agent: null });
  } finally {
    await trx.raw('SET @audit_redaction = 0');
  }
  // Sealed days changed on purpose: record new digests so verification still passes.
  await resealDays(trx, 'audit', days);
}

export const privacyRoutes = defineRoutes('/privacy', ['privacy'])
  .add({
    method: 'post',
    path: '/:entity/:uuid/anonymize',
    permission: 'core.privacy.manage',
    params,
    summary: 'Erase personal data but keep the record (and its deals/activities) for reporting',
    handler: async ({ ctx, user, params: p }) => {
      const def = recordDefs[p.entity];
      await db.transaction(async (trx) => {
        const row = await getRow(def, user, p.uuid, trx, { withDeleted: true, forUpdate: true });
        await trx(def.table)
          .where({ id: row.id })
          .update({ ...PII[p.entity], custom: JSON.stringify({}), updated_by: user.id });
        await trx('taggables').where({ taggable_type: p.entity, taggable_id: row.id }).delete();
        await trx('activities').where({ related_type: p.entity, related_id: row.id }).update({ body: null });
        await redactAudit(trx, p.entity, row.id);
        await audit(trx, ctx, {
          action: `${p.entity}.anonymized`,
          entity: p.entity,
          entityId: row.id,
          entityUuid: p.uuid,
        });
      });
      return { ok: true };
    },
  })
  .add({
    method: 'delete',
    path: '/:entity/:uuid',
    permission: 'core.privacy.manage',
    params,
    query: z.object({ confirm: z.string().max(64).optional() }),
    summary:
      'Permanently delete a record and its activities and files. Call once to get a confirmation code.',
    handler: async ({ ctx, user, params: p, query }) => {
      const def = recordDefs[p.entity];
      const row = await getRow(def, user, p.uuid, db, { withDeleted: true });
      const expected = confirmToken(p.entity, p.uuid);
      if (query.confirm !== expected) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Permanent deletion cannot be undone. Repeat with the confirmation code.',
          [{ path: 'confirm', message: expected }],
        );
      }
      const files = await db('files').where({ entity: p.entity, entity_id: row.id });
      await db.transaction(async (trx) => {
        await trx('activities').where({ related_type: p.entity, related_id: row.id }).delete();
        await trx('taggables').where({ taggable_type: p.entity, taggable_id: row.id }).delete();
        await trx('record_follows').where({ entity: p.entity, entity_id: row.id }).delete();
        await trx('files').where({ entity: p.entity, entity_id: row.id }).delete();
        if (p.entity === 'contact') {
          await trx('contact_organization').where({ contact_id: row.id }).delete();
          await trx('deals').where({ contact_id: row.id }).update({ contact_id: null });
          await trx('leads').where({ converted_contact_id: row.id }).update({ converted_contact_id: null });
        }
        await trx(def.table).where({ id: row.id }).delete();
        await redactAudit(trx, p.entity, row.id);
        await audit(trx, ctx, { action: `${p.entity}.hard_deleted`, entity: p.entity, entityId: row.id });
      });
      for (const f of files) await storage.delete(f.storage_key).catch(() => undefined);
    },
  });
