import type { Knex } from 'knex';
import { SCOPED_RESOURCES, type Housekeeping, type RetentionRule } from '@app/shared';
import { systemContext, type AuthUser, type RequestContext } from '../../http/context';
import { db } from '../../db/knex';
import { logger } from '../../lib/logger';
import { storage } from '../../lib/storage';
import { audit } from '../audit/audit.service';
import { effectiveCompliance } from '../settings/settings.service';
import { recordDefs } from '../records/registry';
import { eraseSubject } from './privacy.service';

const DAY = 86_400_000;
/** Records handled per rule per run, so one run never holds the database for long. */
const BATCH = 200;

/** Retention runs as the system with full scope (it is not a person acting). */
const SYSTEM: AuthUser = {
  id: 0,
  uuid: '00000000-0000-0000-0000-000000000000',
  email: '',
  firstName: 'System',
  lastName: '',
  roleKeys: [],
  isAdmin: true,
  permissions: ['*'],
  scopes: Object.fromEntries(SCOPED_RESOURCES.map((r) => [r, 'all' as const])),
  sessionId: null,
};

const before = (days: number, now: Date) => new Date(now.getTime() - days * DAY);

/** Records a rule applies to now (wrapped: a returned builder would run). */
function ruleQuery(rule: RetentionRule, now: Date) {
  const def = recordDefs[rule.entity];
  const t = def.table;
  const cutoff = before(rule.days, now);
  const qb = db(t);
  if (rule.condition === 'deleted') {
    qb.where(`${t}.deleted_at`, '<', cutoff);
  } else {
    qb.whereNull(`${t}.deleted_at`).where(`${t}.updated_at`, '<', cutoff);
    if (rule.condition === 'lead_closed') qb.whereIn(`${t}.status`, ['converted', 'unqualified']);
    if (rule.condition === 'inactive') {
      // Recent activity, or any open task, means the relationship is still live.
      qb.whereNotExists(
        db('activities')
          .whereRaw('activities.related_type = ?', [rule.entity])
          .whereRaw(`activities.related_id = ${t}.id`)
          .whereNull('activities.deleted_at')
          .where((w) =>
            w
              .where('activities.created_at', '>=', cutoff)
              .orWhere('activities.completed_at', '>=', cutoff)
              .orWhere((o) => o.where('activities.type', 'task').whereNull('activities.completed_at')),
          ),
      );
      // So does an open deal, however long since it changed.
      if (rule.entity === 'contact')
        qb.whereNotExists(
          db('deals')
            .whereRaw('deals.contact_id = contacts.id')
            .whereNull('deals.deleted_at')
            .where((w) => w.where('deals.updated_at', '>=', cutoff).orWhere('deals.status', 'open')),
        );
    }
  }
  // Someone already anonymized needs nothing more (unless the rule deletes).
  if (rule.action === 'anonymize')
    qb.where((w) => w.whereNot(`${t}.first_name`, 'Anonymized').orWhereNotNull(`${t}.email`));
  // Never erase someone with an open privacy request: it must be answered first.
  qb.whereNotExists(
    db('privacy_requests')
      .whereRaw('privacy_requests.subject_type = ?', [rule.entity])
      .whereRaw(`privacy_requests.subject_id = ${t}.id`)
      .whereIn('privacy_requests.status', ['open', 'in_progress']),
  );
  return { qb };
}

type HousekeepingKey = keyof Housekeeping;

function housekeepingQueries(h: Housekeeping, now: Date): Record<HousekeepingKey, Knex.QueryBuilder> {
  return {
    sessionsDays: db('sessions').where((w) =>
      w
        .where('revoked_at', '<', before(h.sessionsDays, now))
        .orWhere('expires_at', '<', before(h.sessionsDays, now)),
    ),
    jobsDays: db('jobs')
      .whereIn('status', ['succeeded', 'failed'])
      .where('finished_at', '<', before(h.jobsDays, now)),
    webhookDeliveriesDays: db('webhook_deliveries')
      .whereIn('status', ['succeeded', 'failed'])
      .where('created_at', '<', before(h.webhookDeliveriesDays, now)),
    notificationsDays: db('notifications')
      .whereNotNull('read_at')
      .where('created_at', '<', before(h.notificationsDays, now)),
    automationRunsDays: db('automation_runs').where('created_at', '<', before(h.automationRunsDays, now)),
    deletedFilesDays: db('files').where('deleted_at', '<', before(h.deletedFilesDays, now)),
  };
}

export interface RetentionPreview {
  rules: { rule: RetentionRule; matches: number }[];
  housekeeping: Record<HousekeepingKey, number>;
}

const count = async (qb: Knex.QueryBuilder) =>
  Number(((await qb.clone().count({ c: '*' }).first()) as { c: number }).c);

export async function previewRetention(now = new Date()): Promise<RetentionPreview> {
  const { retentionRules, housekeeping } = await effectiveCompliance();
  const rules = [];
  for (const rule of retentionRules) rules.push({ rule, matches: await count(ruleQuery(rule, now).qb) });
  const hk = housekeepingQueries(housekeeping, now);
  const counts = {} as Record<HousekeepingKey, number>;
  for (const k of Object.keys(hk) as HousekeepingKey[]) counts[k] = await count(hk[k]);
  return { rules, housekeeping: counts };
}

/** Apply retention rules and housekeeping. Each record is erased in its own transaction. */
/** Candidates examined per rule per run, so records that keep failing cannot block the rest. */
const MAX_ATTEMPTS = 2000;

/** `ctx` names who started a manual run; scheduled runs are the system. */
export async function runRetention(now = new Date(), ctx: RequestContext = systemContext('retention')) {
  const { retentionRules, housekeeping } = await effectiveCompliance();
  const erased: { rule: RetentionRule; done: number; failed: number }[] = [];
  for (const rule of retentionRules) {
    const t = recordDefs[rule.entity].table;
    let done = 0;
    let failed = 0;
    // Page by id so records that fail (for example a legal hold refusing a delete) are passed over.
    for (let afterId = 0; done < BATCH && done + failed < MAX_ATTEMPTS;) {
      const { qb } = ruleQuery(rule, now);
      const page = (await qb
        .where(`${t}.id`, '>', afterId)
        .orderBy(`${t}.id`)
        .limit(BATCH)
        .select(`${t}.id`, `${t}.uuid`)) as { id: number; uuid: string }[];
      if (!page.length) break;
      for (const r of page) {
        if (done >= BATCH) break;
        try {
          await eraseSubject(ctx, SYSTEM, rule.entity, r.uuid, rule.action);
          done++;
        } catch (err) {
          failed++;
          logger.warn({ err, entity: rule.entity, uuid: r.uuid }, 'retention could not erase a record');
        }
      }
      afterId = page[page.length - 1]!.id;
    }
    erased.push({ rule, done, failed });
  }

  const hk = housekeepingQueries(housekeeping, now);
  const cleaned = {} as Record<HousekeepingKey, number>;
  const fileKeys = (await hk.deletedFilesDays.clone().pluck('storage_key')) as string[];
  for (const k of Object.keys(hk) as HousekeepingKey[]) cleaned[k] = await hk[k].delete();
  await db('auth_tokens').where('expires_at', '<', before(housekeeping.sessionsDays, now)).delete();
  for (const key of fileKeys) await storage.delete(key).catch(() => undefined);

  const changed = erased.some((e) => e.done || e.failed) || Object.values(cleaned).some(Boolean);
  if (changed)
    await audit(db, ctx, { action: 'retention.run', entity: 'retention', diff: { erased, cleaned } });
  return { erased, cleaned };
}
