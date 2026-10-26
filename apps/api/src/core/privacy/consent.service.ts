import type {
  ConsentDto,
  ConsentPurpose,
  ConsentSource,
  ConsentSummaryDto,
  DataSubjectEntity,
  LawfulBasis,
} from '@app/shared';
import type { RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { sha256 } from '../../lib/crypto';
import { audit } from '../audit/audit.service';
import { effectiveCompliance } from '../settings/settings.service';

const TABLE: Record<DataSubjectEntity, string> = { contact: 'contacts', lead: 'leads' };

export interface ConsentChange {
  purposeKey: string;
  status: 'granted' | 'withdrawn';
  source: ConsentSource;
  note?: string;
  /** The exact wording the person saw, when it differs from the purpose's current text. */
  text?: string;
}

/**
 * Append a consent decision (proof: wording, hash, time, IP). Marketing purposes keep the
 * subject's `marketing_opt_out` flag in step. Call inside the transaction that caused it.
 */
export async function recordConsent(
  trx: Db,
  ctx: RequestContext,
  subject: { entity: DataSubjectEntity; id: number; uuid: string },
  change: ConsentChange,
  purposes?: ConsentPurpose[],
) {
  const list = purposes ?? (await effectiveCompliance()).consentPurposes;
  const purpose = list.find((p) => p.key === change.purposeKey);
  if (!purpose || (!purpose.active && change.status === 'granted'))
    throw new AppError('VALIDATION_FAILED', 'Unknown consent purpose', [
      { path: 'purposeKey', message: 'Choose a purpose from the compliance settings' },
    ]);
  const text = change.text ?? purpose.text;
  await trx('consents').insert({
    subject_type: subject.entity,
    subject_id: subject.id,
    purpose_key: purpose.key,
    status: change.status,
    lawful_basis: purpose.lawfulBasis,
    source: change.source,
    text_snapshot: text,
    text_hash: sha256(text),
    note: change.note ?? null,
    ip: ctx.ip,
    user_agent: ctx.userAgent?.slice(0, 500) ?? null,
    recorded_by: ctx.user?.id ?? null,
  });
  if (purpose.marketing) await syncMarketingOptOut(trx, subject, list);
  await audit(trx, ctx, {
    action: `consent.${change.status}`,
    entity: subject.entity,
    entityId: subject.id,
    entityUuid: subject.uuid,
    diff: { purpose: purpose.key, source: change.source },
  });
}

/** Opted out unless the latest decision for at least one marketing purpose is a grant. */
async function syncMarketingOptOut(
  trx: Db,
  subject: { entity: DataSubjectEntity; id: number },
  purposes: ConsentPurpose[],
) {
  const latest = await latestDecisions(trx, subject);
  const marketing = purposes.filter((p) => p.marketing).map((p) => p.key);
  const granted = marketing.some((k) => latest.get(k)?.status === 'granted');
  await trx(TABLE[subject.entity]).where({ id: subject.id }).update({ marketing_opt_out: !granted });
}

async function latestDecisions(conn: Db, subject: { entity: DataSubjectEntity; id: number }) {
  const rows = await conn('consents')
    .where({ subject_type: subject.entity, subject_id: subject.id })
    .orderBy('id', 'asc')
    .select('purpose_key', 'status');
  return new Map(rows.map((r) => [r.purpose_key as string, r as { status: 'granted' | 'withdrawn' }]));
}

/** Withdraw every marketing purpose (unsubscribe link, objection, opt-out of sale or sharing). */
export async function withdrawMarketing(
  trx: Db,
  ctx: RequestContext,
  subject: { entity: DataSubjectEntity; id: number; uuid: string },
  source: ConsentSource,
  note?: string,
) {
  const { consentPurposes } = await effectiveCompliance();
  const latest = await latestDecisions(trx, subject);
  for (const p of consentPurposes.filter((x) => x.marketing)) {
    if (latest.get(p.key)?.status !== 'withdrawn')
      await recordConsent(
        trx,
        ctx,
        subject,
        { purposeKey: p.key, status: 'withdrawn', source, note },
        consentPurposes,
      );
  }
  // Opt out even when no marketing purposes are configured.
  await trx(TABLE[subject.entity]).where({ id: subject.id }).update({ marketing_opt_out: true });
}

export async function consentSummary(
  subject: { entity: DataSubjectEntity; id: number },
  conn: Db = db,
): Promise<ConsentSummaryDto> {
  const { consentPurposes } = await effectiveCompliance();
  const rows = await conn('consents as c')
    .leftJoin('users as u', 'u.id', 'c.recorded_by')
    .where({ 'c.subject_type': subject.entity, 'c.subject_id': subject.id })
    .orderBy('c.id', 'desc')
    .select('c.*', 'u.uuid as user_uuid', 'u.first_name', 'u.last_name', 'u.email as user_email');
  const label = (key: string) => consentPurposes.find((p) => p.key === key)?.label ?? key;
  const history: ConsentDto[] = rows.map((r) => ({
    purposeKey: r.purpose_key,
    purposeLabel: label(r.purpose_key),
    status: r.status,
    lawfulBasis: r.lawful_basis as LawfulBasis,
    source: r.source as ConsentSource,
    textSnapshot: r.text_snapshot,
    textHash: r.text_hash,
    recordedBy: r.user_uuid
      ? { uuid: r.user_uuid, name: `${r.first_name} ${r.last_name}`.trim() || r.user_email }
      : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
  const keys = new Set([
    ...consentPurposes.filter((p) => p.active).map((p) => p.key),
    ...rows.map((r) => r.purpose_key as string),
  ]);
  const flags = await conn(TABLE[subject.entity])
    .where({ id: subject.id })
    .first('marketing_opt_out', 'processing_restricted');
  return {
    current: [...keys].map((k) => ({
      purposeKey: k,
      purposeLabel: label(k),
      status: history.find((h) => h.purposeKey === k)?.status ?? 'none',
    })),
    history,
    marketingOptOut: !!flags?.marketing_opt_out,
    processingRestricted: !!flags?.processing_restricted,
  };
}
