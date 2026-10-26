import type { Response } from 'express';
import { ZipFile } from 'yazl';
import {
  SENSITIVE_MASK,
  type CustomFieldDef,
  type DataSubjectEntity,
  type ErasureReportDto,
  type VisibilityLevel,
} from '@app/shared';
import type { AuthUser, RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { storage } from '../../lib/storage';
import { audit } from '../audit/audit.service';
import { logAccess } from '../audit/access-log';
import { brokenSealedDays, daysOf, resealDays } from '../audit/integrity';
import { recordDefs } from '../records/registry';
import { escapeLike } from '../records/filters';
import { decryptCustom, isEncryptedValue, redactDiff } from '../records/custom';
import { customContext } from '../records/common';
import { getRow, scopedQuery } from '../records/service';
import { can } from '../rbac/access';
import { activitiesDef } from '../activities/activities.def';
import { dealsDef } from '../deals/deals.def';
import { organizationsDef } from '../organizations/organizations.def';
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
  const brokenBefore = await brokenSealedDays(trx, 'audit', [...days]);
  await trx.raw('SET @audit_redaction = 1');
  try {
    const blank = { diff: JSON.stringify({ redacted: true }), ip: null, user_agent: null };
    await trx('audit_logs').where({ entity, entity_id: id }).update(blank);
    if (activityIds.length)
      await trx('audit_logs').where({ entity: 'activity' }).whereIn('entity_id', activityIds).update(blank);
  } finally {
    await trx.raw('SET @audit_redaction = 0');
  }
  await resealDays(trx, 'audit', [...days], brokenBefore);
}

/** Core tables outside the record itself that copy the person's data. */
async function eraseCoreTraces(
  trx: Db,
  subject: DataSubject,
  mode: 'anonymize' | 'delete',
  cleared: Record<string, number>,
) {
  const { entity, id, uuid, email } = subject;
  const add = (k: string, n: number) => (cleared[k] = (cleared[k] ?? 0) + n);
  const activityIds = (await trx('activities')
    .where({ related_type: entity, related_id: id })
    .pluck('id')) as number[];

  // Copies of email traffic: on the person's activities, and any message to or from their address.
  const blankMail = {
    from_address: '',
    to_addresses: JSON.stringify([]),
    cc_addresses: JSON.stringify([]),
    subject: '',
  };
  if (activityIds.length)
    add('emailMessages', await trx('email_messages').whereIn('activity_id', activityIds).update(blankMail));
  if (email)
    add(
      'emailMessages',
      await trx('email_messages')
        .where((w) =>
          w
            .where('from_address', email)
            .orWhereRaw('JSON_CONTAINS(to_addresses, JSON_QUOTE(?))', [email])
            .orWhereRaw('JSON_CONTAINS(cc_addresses, JSON_QUOTE(?))', [email]),
        )
        .update(blankMail),
    );
  if (mode === 'anonymize') {
    // Subjects ("Call with Jane") and outcomes identify the person as much as the notes do.
    add(
      'activities',
      await trx('activities')
        .where({ related_type: entity, related_id: id })
        .update({ subject: '', body: null, outcome: null, custom: null }),
    );
  } else {
    add('activities', await trx('activities').where({ related_type: entity, related_id: id }).delete());
  }

  // Webhook payloads and finished jobs carried full record snapshots.
  add(
    'webhookDeliveries',
    await trx('webhook_deliveries')
      .whereRaw("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.data.uuid')) = ?", [uuid])
      .update({ payload: JSON.stringify({ redacted: true }) }),
  );
  add(
    'jobs',
    await trx('jobs')
      .whereIn('status', ['succeeded', 'failed'])
      .where('payload', 'like', `%${escapeLike(uuid)}%`)
      .update({ payload: JSON.stringify({ redacted: true }), result: null }),
  );
  add(
    'automationRuns',
    await trx('automation_runs')
      .where({ record_uuid: uuid })
      .update({ log: JSON.stringify(['redacted']) }),
  );
  add(
    'notifications',
    await trx('notifications')
      .where('link', 'like', `%${escapeLike(uuid)}%`)
      .delete(),
  );

  // Consent proof stays on anonymized records (without the IP); it goes with a deleted one.
  await trx.raw('SET @audit_redaction = 1');
  try {
    const consents = trx('consents').where({ subject_type: entity, subject_id: id });
    add(
      'consents',
      mode === 'delete' ? await consents.delete() : await consents.update({ ip: null, user_agent: null }),
    );
  } finally {
    await trx.raw('SET @audit_redaction = 0');
  }

  await trx('taggables').where({ taggable_type: entity, taggable_id: id }).delete();
  return activityIds;
}

/**
 * The person's record plus every duplicate merged into it (merges keep the merged-away rows,
 * soft-deleted, with their original details). Primary first.
 */
async function subjectRows(conn: Db, entity: DataSubjectEntity, primary: Row): Promise<Row[]> {
  const rows: Row[] = [primary];
  if (entity !== 'contact') return rows;
  let frontier = [primary.id];
  while (frontier.length) {
    const next = (await conn('contacts').whereIn('merged_into_id', frontier)) as Row[];
    rows.push(...next);
    frontier = next.map((r) => r.id);
  }
  return rows;
}

const asSubject = (entity: DataSubjectEntity, r: Row): DataSubject => ({
  entity,
  id: r.id,
  uuid: r.uuid,
  email: (r.email as string | null) ?? null,
});

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
    const { row, subject } = await loadSubject(user, entity, uuid, trx, true);
    const rows = await subjectRows(trx, entity, row);
    const ids = rows.map((r) => r.id);
    if (rows.length > 1) report.cleared.mergedDuplicates = rows.length - 1;
    const files = await trx('files').where({ entity }).whereIn('entity_id', ids);
    storageKeys.push(...files.map((f) => f.storage_key as string));
    report.cleared.files = await trx('files').where({ entity }).whereIn('entity_id', ids).delete();

    const handlers = await privacyHandlers(trx);
    for (const r of rows) {
      const s = asSubject(entity, r);
      for (const h of handlers) {
        const res = await h.erase(s, trx, mode);
        for (const [k, v] of Object.entries(res.cleared ?? {}))
          report.cleared[`${h.key}.${k}`] = (report.cleared[`${h.key}.${k}`] ?? 0) + v;
        report.retained.push(...(res.retained ?? []));
      }
    }

    // Duplicates merged away are deleted outright: their history already lives on the primary.
    for (const r of rows) {
      const s = asSubject(entity, r);
      const isPrimary = r.id === subject.id;
      const rowMode = isPrimary ? mode : 'delete';
      const activityIds = await eraseCoreTraces(trx, s, rowMode, report.cleared);
      if (rowMode === 'anonymize') {
        await trx(def.table)
          .where({ id: r.id })
          .update({ ...PII[entity], custom: JSON.stringify({}), updated_by: user.id || null });
        if (entity === 'contact')
          await trx('contact_organization').where({ contact_id: r.id }).update({ job_title: null });
      } else {
        await trx('record_follows').where({ entity, entity_id: r.id }).delete();
        if (entity === 'contact') {
          await trx('contact_organization').where({ contact_id: r.id }).delete();
          await trx('deals').where({ contact_id: r.id }).update({ contact_id: null });
          await trx('leads').where({ converted_contact_id: r.id }).update({ converted_contact_id: null });
          await trx('contacts').where({ merged_into_id: r.id }).update({ merged_into_id: null });
        }
        // Privacy requests stay (proof the request was handled), unlinked when the record goes.
        await trx('privacy_requests')
          .where({ subject_type: entity, subject_id: r.id })
          .update({ subject_id: null });
        await trx(def.table).where({ id: r.id }).delete();
      }
      await redactAudit(trx, entity, r.id, activityIds);
    }

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
/** JSON-ready rows without internal database ids (ids never leave the API). */
const plain = (rows: Record<string, unknown>[]) =>
  rows.map((r) =>
    Object.fromEntries(
      Object.entries(r)
        .filter(([k]) => k !== 'id' && !k.endsWith('_id'))
        .map(([k, v]) => [k, iso(v)]),
    ),
  );

/**
 * Custom values as this user may see them: hidden fields left out, sensitive values in plain text
 * only for people who may reveal them (masked otherwise).
 */
function visibleCustom(
  custom: unknown,
  defs: CustomFieldDef[],
  levels: Record<string, VisibilityLevel>,
  canReveal: boolean,
): Record<string, unknown> {
  const src = (custom && typeof custom === 'object' ? custom : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = src[d.key];
    if (v === undefined || v === null || levels[d.key] === 'hidden') continue;
    if (!isEncryptedValue(v)) out[d.key] = v;
    else out[d.key] = canReveal ? decryptCustom({ v }).v : SENSITIVE_MASK;
  }
  return out;
}

/**
 * Right of access and portability: one ZIP with what is held about the person, as JSON
 * (machine-readable), plus their files. It contains only what the exporting user may see
 * themselves: their record scope, field visibility, the reveal permission for sensitive values,
 * and module data only for modules they can view.
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
  const rows = await subjectRows(db, entity, row);
  const ids = rows.map((r) => r.id);
  const canReveal = can(user, 'core.fields.reveal');
  const own = await customContext(entity, user);
  const recordOut = (r: Row) => ({ ...r, custom: visibleCustom(r.custom, own.defs, own.levels, canReveal) });

  // Activities and deals: only those inside the user's own scope.
  const actCtx = await customContext('activity', user);
  const { qb: actQb } = await scopedQuery(activitiesDef, user, db, 'with');
  const activities = can(user, `${activitiesDef.resource}.view`)
    ? ((await actQb
        .where('activities.related_type', entity)
        .whereIn('activities.related_id', ids)
        .orderBy('activities.id')
        .select('activities.*')) as Row[])
    : [];
  const sections: Record<string, unknown> = {
    record: plain([recordOut(row)])[0],
    ...(rows.length > 1 ? { mergedRecords: plain(rows.slice(1).map(recordOut)) } : {}),
    activities: plain(
      activities.map((a) => ({
        ...a,
        custom: visibleCustom(a.custom, actCtx.defs, actCtx.levels, canReveal),
      })),
    ),
    emails: plain(
      activities.length
        ? await db('email_messages').whereIn(
            'activity_id',
            activities.map((a) => a.id),
          )
        : [],
    ),
    consents: await consentSummary(subject),
    consentHistory: plain(
      await db('consents')
        .where({ subject_type: entity })
        .whereIn('subject_id', ids)
        .orderBy('id')
        .select('purpose_key', 'status', 'lawful_basis', 'source', 'text_snapshot', 'note', 'created_at'),
    ),
    privacyRequests: plain(
      await db('privacy_requests')
        .where({ subject_type: entity })
        .whereIn('subject_id', ids)
        .orderBy('id')
        .select('type', 'status', 'channel', 'received_at', 'due_at', 'resolution', 'completed_at'),
    ),
    history: plain(
      (
        await db('audit_logs')
          .where({ entity })
          .whereIn('entity_id', ids)
          .orderBy('id')
          .select('action', 'diff', 'created_at')
      ).map((h) => ({
        ...h,
        diff:
          h.diff && typeof h.diff === 'object'
            ? redactDiff(h.diff as Record<string, unknown>, own.levels)
            : h.diff,
      })),
    ),
  };
  if (entity === 'contact') {
    const { qb: orgQb } = await scopedQuery(organizationsDef, user, db);
    const canOrgs = can(user, `${organizationsDef.resource}.view`);
    orgQb.select('organizations.id');
    sections.organizations = plain(
      await db('contact_organization as co')
        .join('organizations as o', 'o.id', 'co.organization_id')
        .whereIn('co.contact_id', ids)
        .whereIn('co.organization_id', canOrgs ? orgQb : [0])
        .select(
          'o.name',
          'co.relationship_type',
          'co.job_title',
          'co.is_primary',
          'co.started_at',
          'co.ended_at',
        ),
    );
    const { qb: dealQb } = await scopedQuery(dealsDef, user, db);
    sections.deals = can(user, `${dealsDef.resource}.view`)
      ? plain(
          await dealQb
            .whereIn('deals.contact_id', ids)
            .select(
              'deals.uuid',
              'deals.title',
              'deals.value',
              'deals.currency',
              'deals.status',
              'deals.created_at',
            ),
        )
      : [];
  }
  const modules: Record<string, Record<string, unknown[]>> = {};
  for (const h of await privacyHandlers(db)) {
    if (!can(user, h.viewPermission)) continue;
    for (const r of rows) {
      for (const [area, list] of Object.entries(await h.export(asSubject(entity, r), db))) {
        modules[h.key] ??= {};
        modules[h.key]![area] = [
          ...(modules[h.key]![area] ?? []),
          ...plain((list ?? []) as Record<string, unknown>[]),
        ];
      }
    }
  }
  sections.modules = modules;
  const files = can(user, 'core.files.view')
    ? await db('files').where({ entity }).whereIn('entity_id', ids).whereNull('deleted_at')
    : [];
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
  // Resolve only once the whole file is sent: the router answers 204 to a handler that returns first.
  await new Promise<void>((resolve, reject) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    zip.outputStream.once('error', reject);
    zip.end();
  });
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

/**
 * Whether an event concerns a restricted person: the record itself, the person linked to a deal,
 * or the record an activity belongs to.
 */
export async function eventTouchesRestricted(e: {
  entity: string;
  uuid: string;
  record?: Record<string, unknown> | null;
}): Promise<boolean> {
  if (await isRestricted(e.entity, e.uuid)) return true;
  const r = e.record ?? {};
  const contact = r.contact as { uuid?: string } | null | undefined;
  if (e.entity === 'deal' && contact?.uuid) return isRestricted('contact', contact.uuid);
  const related = r.related as { type?: string; uuid?: string } | null | undefined;
  if (e.entity === 'activity' && related?.type && related.uuid)
    return isRestricted(related.type, related.uuid);
  return false;
}

/** Restricted contacts or leads among email recipients (GDPR Art. 18 covers every channel). */
export async function restrictedRecipients(addresses: string[], conn: Db = db): Promise<number> {
  const list = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return 0;
  let n = 0;
  for (const table of ['contacts', 'leads']) {
    const row = await conn(table)
      .where({ processing_restricted: true })
      .whereRaw(`LOWER(email) IN (${list.map(() => '?').join(', ')})`, list)
      .count({ c: '*' })
      .first();
    n += Number((row as { c: number }).c);
  }
  return n;
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
