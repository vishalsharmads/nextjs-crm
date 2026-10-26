import type { Response } from 'express';
import { ZipFile } from 'yazl';
import type { DataSubjectEntity, ErasureReportDto } from '@app/shared';
import type { AuthUser, RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { storage } from '../../lib/storage';
import { audit } from '../audit/audit.service';
import { logAccess } from '../audit/access-log';
import { daysOf, resealDays } from '../audit/integrity';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';
import { escapeLike } from '../records/filters';
import { decryptCustom } from '../records/custom';
import { consentSummary } from './consent.service';
import { readStoredFile } from '../files/files.service';
import { privacyHandlers, type DataSubject } from './handlers';

/** Personal columns blanked by anonymization (structure and history stay for reporting). */
const PII: Record<DataSubjectEntity, Record<string, string | null>> = {
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

type Row = Record<string, unknown> & { id: number; uuid: string };

async function loadSubject(
  user: AuthUser,
  entity: DataSubjectEntity,
  uuid: string,
  conn: Db,
  forUpdate = false,
) {
  const row = (await getRow(recordDefs[entity], user, uuid, conn, { withDeleted: true, forUpdate })) as Row;
  const subject: DataSubject = { entity, id: row.id, uuid, email: (row.email as string | null) ?? null };
  return { row, subject };
}

/**
 * Remove personal data from the audit log for the subject and its activities. This is the only
 * sanctioned modification of audit_logs (privacy law outranks immutability, decision D6); the
 * session flag opens the trigger, sealed days are resealed, and the redaction itself is audited.
 */
async function redactAudit(trx: Db, entity: string, id: number, activityIds: number[]) {
  const targets: Record<string, unknown>[] = [{ entity, entity_id: id }];
  if (activityIds.length) targets.push({ entity: 'activity' });
  const days = new Set<string>();
  for (const d of await daysOf(trx, 'audit', { entity, entity_id: id })) days.add(d);
  const activityRows = activityIds.length
    ? await trx('audit_logs')
        .where({ entity: 'activity' })
        .whereIn('entity_id', activityIds)
        .distinct(trx.raw('DATE(created_at) as day'))
    : [];
  for (const r of activityRows)
    days.add(typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10));
  await trx.raw('SET @audit_redaction = 1');
  try {
    const blank = { diff: JSON.stringify({ redacted: true }), ip: null, user_agent: null };
    await trx('audit_logs').where({ entity, entity_id: id }).update(blank);
    if (activityIds.length)
      await trx('audit_logs').where({ entity: 'activity' }).whereIn('entity_id', activityIds).update(blank);
  } finally {
    await trx.raw('SET @audit_redaction = 0');
  }
  await resealDays(trx, 'audit', [...days]);
}

/** Core tables outside the record itself that copy the person's data. */
async function eraseCoreTraces(
  trx: Db,
  subject: DataSubject,
  mode: 'anonymize' | 'delete',
  cleared: Record<string, number>,
) {
  const { entity, id, uuid } = subject;
  const activityIds = (await trx('activities')
    .where({ related_type: entity, related_id: id })
    .pluck('id')) as number[];

  // Copies of email traffic: addresses and subjects (bodies live on the activity).
  if (activityIds.length) {
    cleared.emailMessages = await trx('email_messages')
      .whereIn('activity_id', activityIds)
      .update({
        from_address: '',
        to_addresses: JSON.stringify([]),
        cc_addresses: JSON.stringify([]),
        subject: '',
      });
  }
  if (mode === 'anonymize') {
    cleared.activities = await trx('activities')
      .where({ related_type: entity, related_id: id })
      .update({ body: null });
    await trx('activities')
      .where({ related_type: entity, related_id: id, type: 'email' })
      .update({ subject: '' });
  } else {
    cleared.activities = await trx('activities').where({ related_type: entity, related_id: id }).delete();
  }

  // Webhook payloads and finished jobs carried full record snapshots.
  cleared.webhookDeliveries = await trx('webhook_deliveries')
    .whereRaw("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.data.uuid')) = ?", [uuid])
    .update({ payload: JSON.stringify({ redacted: true }) });
  cleared.jobs = await trx('jobs')
    .whereIn('status', ['succeeded', 'failed'])
    .where('payload', 'like', `%${escapeLike(uuid)}%`)
    .update({ payload: JSON.stringify({ redacted: true }), result: null });
  cleared.automationRuns = await trx('automation_runs')
    .where({ record_uuid: uuid })
    .update({ log: JSON.stringify(['redacted']) });
  cleared.notifications = await trx('notifications')
    .where('link', 'like', `%${escapeLike(uuid)}%`)
    .delete();

  // Consent proof stays on anonymized records (without the IP); it goes with a deleted one.
  await trx.raw('SET @audit_redaction = 1');
  try {
    const consents = trx('consents').where({ subject_type: entity, subject_id: id });
    cleared.consents =
      mode === 'delete' ? await consents.delete() : await consents.update({ ip: null, user_agent: null });
  } finally {
    await trx.raw('SET @audit_redaction = 0');
  }

  await trx('taggables').where({ taggable_type: entity, taggable_id: id }).delete();
  return activityIds;
}

/** Anonymize (keep the record without personal data) or delete a contact or lead everywhere. */
export async function eraseSubject(
  ctx: RequestContext,
  user: AuthUser,
  entity: DataSubjectEntity,
  uuid: string,
  mode: 'anonymize' | 'delete',
): Promise<ErasureReportDto> {
  const def = recordDefs[entity];
  const report: ErasureReportDto = { mode, cleared: {}, retained: [] };
  const storageKeys: string[] = [];
  await db.transaction(async (trx) => {
    const { subject } = await loadSubject(user, entity, uuid, trx, true);
    const files = await trx('files').where({ entity, entity_id: subject.id });
    storageKeys.push(...files.map((f) => f.storage_key as string));
    report.cleared.files = await trx('files').where({ entity, entity_id: subject.id }).delete();

    for (const h of await privacyHandlers(trx)) {
      const r = await h.erase(subject, trx, mode);
      for (const [k, v] of Object.entries(r.cleared ?? {})) report.cleared[`${h.key}.${k}`] = v;
      report.retained.push(...(r.retained ?? []));
    }

    const activityIds = await eraseCoreTraces(trx, subject, mode, report.cleared);

    if (mode === 'anonymize') {
      await trx(def.table)
        .where({ id: subject.id })
        .update({ ...PII[entity], custom: JSON.stringify({}), updated_by: user.id || null });
    } else {
      await trx('record_follows').where({ entity, entity_id: subject.id }).delete();
      if (entity === 'contact') {
        await trx('contact_organization').where({ contact_id: subject.id }).delete();
        await trx('deals').where({ contact_id: subject.id }).update({ contact_id: null });
        await trx('leads').where({ converted_contact_id: subject.id }).update({ converted_contact_id: null });
      }
      await trx(def.table).where({ id: subject.id }).delete();
    }
    // Privacy requests stay (proof the request was handled), unlinked when the record goes.
    if (mode === 'delete')
      await trx('privacy_requests')
        .where({ subject_type: entity, subject_id: subject.id })
        .update({ subject_id: null });

    await redactAudit(trx, entity, subject.id, activityIds);
    await audit(trx, ctx, {
      action: `${entity}.${mode === 'delete' ? 'hard_deleted' : 'anonymized'}`,
      entity,
      entityId: subject.id,
      entityUuid: mode === 'delete' ? null : uuid,
      diff: { cleared: report.cleared, retained: report.retained },
    });
  });
  for (const key of storageKeys) await storage.delete(key).catch(() => undefined);
  return report;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
const plain = (rows: Record<string, unknown>[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)])));

/**
 * Right of access and portability: one ZIP with everything held about the person, as JSON
 * (machine-readable), plus their files. Privileged: includes custom fields hidden from staff.
 */
export async function exportSubject(
  ctx: RequestContext,
  user: AuthUser,
  entity: DataSubjectEntity,
  uuid: string,
  res: Response,
) {
  const { row, subject } = await loadSubject(user, entity, uuid, db);
  const { id } = subject;
  const activities = await db('activities').where({ related_type: entity, related_id: id }).orderBy('id');
  const sections: Record<string, unknown> = {
    record: plain([{ ...row, custom: decryptCustom(row.custom) }])[0],
    activities: plain(activities),
    emails: plain(
      activities.length
        ? await db('email_messages').whereIn(
            'activity_id',
            activities.map((a) => a.id as number),
          )
        : [],
    ),
    consents: await consentSummary(subject),
    privacyRequests: plain(
      await db('privacy_requests').where({ subject_type: entity, subject_id: id }).orderBy('id'),
    ),
    history: plain(
      await db('audit_logs')
        .where({ entity, entity_id: id })
        .orderBy('id')
        .select('action', 'diff', 'created_at'),
    ),
  };
  if (entity === 'contact') {
    sections.organizations = plain(
      await db('contact_organization as co')
        .join('organizations as o', 'o.id', 'co.organization_id')
        .where('co.contact_id', id)
        .select(
          'o.name',
          'co.relationship_type',
          'co.job_title',
          'co.is_primary',
          'co.started_at',
          'co.ended_at',
        ),
    );
    sections.deals = plain(
      await db('deals')
        .where({ contact_id: id })
        .whereNull('deleted_at')
        .select('uuid', 'title', 'value', 'currency', 'status', 'created_at'),
    );
  }
  const modules: Record<string, unknown> = {};
  for (const h of await privacyHandlers(db)) modules[h.key] = await h.export(subject, db);
  sections.modules = modules;
  const files = await db('files').where({ entity, entity_id: id }).whereNull('deleted_at');
  sections.files = files.map((f) => ({
    name: f.original_name,
    mime: f.mime,
    size: f.size,
    uploadedAt: iso(f.created_at),
  }));

  await audit(db, ctx, {
    action: `${entity}.data_exported`,
    entity,
    entityId: id,
    entityUuid: uuid,
    diff: { files: files.length },
  });
  await logAccess(ctx, {
    action: 'export',
    entity,
    entityId: id,
    entityUuid: uuid,
    detail: { kind: 'data_subject' },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="personal-data-${stamp}.zip"`);
  const zip = new ZipFile();
  zip.outputStream.pipe(res);
  zip.addBuffer(Buffer.from(JSON.stringify(sections, null, 2)), 'personal-data.json');
  const used = new Set<string>();
  for (const f of files) {
    let name = `files/${String(f.original_name).replace(/[\\/:*?"<>|]/g, '_')}`;
    while (used.has(name)) name = name.replace(/(\.[^.]*)?$/, (ext) => `-${used.size}${ext}`);
    used.add(name);
    try {
      zip.addBuffer(await readStoredFile(f as { storage_key: string; enc_kid: string | null }), name);
    } catch (err) {
      logger.error({ err, file: f.uuid }, 'file missing from storage during data export');
    }
  }
  zip.end();
}

/** Turn processing restriction (GDPR Art. 18) on or off. */
export async function setRestriction(
  ctx: RequestContext,
  user: AuthUser,
  entity: DataSubjectEntity,
  uuid: string,
  restricted: boolean,
) {
  await db.transaction(async (trx) => {
    const { subject } = await loadSubject(user, entity, uuid, trx, true);
    await trx(recordDefs[entity].table)
      .where({ id: subject.id })
      .update({ processing_restricted: restricted });
    await audit(trx, ctx, {
      action: `${entity}.${restricted ? 'restricted' : 'unrestricted'}`,
      entity,
      entityId: subject.id,
      entityUuid: uuid,
    });
  });
}

/** Whether automations, webhooks and outgoing email must skip this record. */
export async function isRestricted(entity: string, uuid: string, conn: Db = db): Promise<boolean> {
  if (entity !== 'contact' && entity !== 'lead') return false;
  const row = await conn(recordDefs[entity].table).where({ uuid }).first('processing_restricted');
  return !!row?.processing_restricted;
}

export function assertSubjectEntity(entity: string): asserts entity is DataSubjectEntity {
  if (entity !== 'contact' && entity !== 'lead') throw new AppError('NOT_FOUND', 'Not found');
}
