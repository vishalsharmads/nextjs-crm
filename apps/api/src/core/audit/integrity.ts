import { createHash } from 'node:crypto';
import { db, type Db } from '../../db/knex';
import { logger } from '../../lib/logger';
import { systemContext } from '../../http/context';
import { effectiveCompliance } from '../settings/settings.service';
import { audit } from './audit.service';

/**
 * Tamper evidence for the audit and access logs. Each complete UTC day is sealed with a SHA-256
 * digest of its rows, and every digest is chained to the previous day's. A change to any sealed
 * row, or a deleted or inserted row, breaks the day's digest; editing a digest breaks the chain.
 * Digests are also written to the application log, so a copy can live outside the database.
 */
export const LOG_SOURCES = { audit: 'audit_logs', access: 'access_logs' } as const;
export type LogSource = keyof typeof LOG_SOURCES;

const GENESIS = '0'.repeat(64);
const BATCH = 5000;
const DAY_MS = 86_400_000;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const startOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const addDays = (day: string, n: number) => dayKey(new Date(startOf(day).getTime() + n * DAY_MS));

const COLUMNS: Record<LogSource, string[]> = {
  audit: [
    'id',
    'actor_id',
    'actor_type',
    'action',
    'entity',
    'entity_id',
    'entity_uuid',
    'diff',
    'ip',
    'user_agent',
    'request_id',
    'created_at',
  ],
  access: [
    'id',
    'actor_id',
    'actor_type',
    'action',
    'entity',
    'entity_id',
    'entity_uuid',
    'detail',
    'ip',
    'user_agent',
    'request_id',
    'created_at',
  ],
};

function canonical(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  return v ?? null;
}

/** Digest of one day's rows, read in id order. */
export async function digestDay(source: LogSource, day: string, conn: Db = db) {
  const hash = createHash('sha256');
  const from = startOf(day);
  const to = new Date(from.getTime() + DAY_MS);
  let afterId = 0;
  let count = 0;
  let firstId: number | null = null;
  let lastId: number | null = null;
  for (;;) {
    const rows = await conn(LOG_SOURCES[source])
      .where('created_at', '>=', from)
      .where('created_at', '<', to)
      .where('id', '>', afterId)
      .orderBy('id')
      .limit(BATCH)
      .select(COLUMNS[source]);
    for (const r of rows) {
      hash.update(`${JSON.stringify(COLUMNS[source].map((c) => canonical(r[c])))}\n`);
      firstId ??= r.id as number;
      lastId = r.id as number;
    }
    count += rows.length;
    if (rows.length < BATCH) break;
    afterId = lastId!;
  }
  return { digest: hash.digest('hex'), count, firstId, lastId };
}

const chainOf = (prev: string, source: LogSource, day: string, digest: string, count: number) =>
  createHash('sha256').update(`${prev}|${source}|${day}|${digest}|${count}`).digest('hex');

/** Seal every complete day not sealed yet. Safe to run repeatedly and concurrently. */
export async function sealPendingDays(source: LogSource, now = new Date()): Promise<number> {
  const today = dayKey(now);
  const last = await db('audit_digests').where({ source }).orderBy('day', 'desc').first();
  let day: string;
  if (last) {
    day = addDays(String(last.day), 1);
  } else {
    const first = await db(LOG_SOURCES[source]).min({ at: 'created_at' }).first();
    if (!first?.at) return 0;
    day = dayKey(new Date(first.at as Date));
  }
  let prev = (last?.chain as string | undefined) ?? GENESIS;
  let sealed = 0;
  for (; day < today; day = addDays(day, 1)) {
    const d = await digestDay(source, day);
    const chain = chainOf(prev, source, day, d.digest, d.count);
    // Raw INSERT IGNORE so affectedRows says whether this worker sealed the day.
    const [res] = (await db.raw(
      'INSERT IGNORE INTO audit_digests (source, day, row_count, first_id, last_id, digest, chain) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [source, day, d.count, d.firstId, d.lastId, d.digest, chain],
    )) as [{ affectedRows: number }];
    if (!res.affectedRows) return sealed; // another worker got there first
    logger.info({ source, day, rows: d.count, digest: d.digest, chain }, 'audit log day sealed');
    prev = chain;
    sealed++;
  }
  return sealed;
}

export interface IntegrityProblem {
  source: LogSource;
  day: string;
  problem: 'rows_changed' | 'chain_broken';
}

/** Recompute sealed days and the chain. Purged days are checked through the chain only. */
export async function verifyIntegrity(
  opts: { from?: string; to?: string; sources?: LogSource[] } = {},
): Promise<{ daysChecked: number; problems: IntegrityProblem[]; sealedThrough: string | null }> {
  const problems: IntegrityProblem[] = [];
  let daysChecked = 0;
  let sealedThrough: string | null = null;
  for (const source of opts.sources ?? (Object.keys(LOG_SOURCES) as LogSource[])) {
    const rows = await db('audit_digests').where({ source }).orderBy('day');
    let prev = GENESIS;
    for (const r of rows) {
      const day = typeof r.day === 'string' ? r.day : dayKey(new Date(r.day as Date));
      if (chainOf(prev, source, day, r.digest, r.row_count) !== r.chain)
        problems.push({ source, day, problem: 'chain_broken' });
      prev = r.chain as string;
      if (r.purged_at || (opts.from && day < opts.from) || (opts.to && day > opts.to)) continue;
      const d = await digestDay(source, day);
      daysChecked++;
      if (d.digest !== r.digest || d.count !== r.row_count)
        problems.push({ source, day, problem: 'rows_changed' });
      if (!sealedThrough || day > sealedThrough) sealedThrough = day;
    }
  }
  return { daysChecked, problems, sealedThrough };
}

/**
 * After a privileged redaction (privacy erasure) rewrote rows on sealed days, recompute those
 * days and every later link of the chain, and audit the old and new digests.
 */
export async function resealDays(trx: Db, source: LogSource, days: string[]) {
  const sealed = await trx('audit_digests')
    .where({ source })
    .whereIn('day', days)
    .orderBy('day')
    .select('day', 'digest');
  if (!sealed.length) return;
  const changes: { day: string; from: string; to: string }[] = [];
  for (const s of sealed) {
    const day = typeof s.day === 'string' ? s.day : dayKey(new Date(s.day as Date));
    const d = await digestDay(source, day, trx);
    await trx('audit_digests').where({ source, day }).update({ digest: d.digest, row_count: d.count });
    changes.push({ day, from: s.digest as string, to: d.digest });
  }
  const all = await trx('audit_digests').where({ source }).orderBy('day');
  let prev = GENESIS;
  for (const r of all) {
    const day = typeof r.day === 'string' ? r.day : dayKey(new Date(r.day as Date));
    const chain = chainOf(prev, source, day, r.digest, r.row_count);
    if (chain !== r.chain) await trx('audit_digests').where({ source, day }).update({ chain });
    prev = chain;
  }
  await audit(trx, systemContext('privacy-reseal'), {
    action: 'audit.resealed',
    entity: 'audit_log',
    diff: { source, changes },
  });
  logger.info({ source, changes }, 'audit log days resealed after redaction');
}

/** Days (UTC) that hold the matching rows: call before a redaction to know what to reseal. */
export async function daysOf(conn: Db, source: LogSource, where: Record<string, unknown>): Promise<string[]> {
  const rows = await conn(LOG_SOURCES[source]).where(where).distinct(conn.raw('DATE(created_at) as day'));
  return rows.map((r) => (typeof r.day === 'string' ? r.day : dayKey(new Date(r.day as Date))));
}

/**
 * Retention: delete rows older than the configured days, but only on sealed days, so their
 * digests remain as evidence of what existed. Runs in batches; each batch is its own transaction.
 */
export async function purgeExpiredLogs(now = new Date()): Promise<Record<LogSource, number>> {
  const result = { audit: 0, access: 0 };
  const { auditRetentionDays } = await effectiveCompliance();
  if (!auditRetentionDays) return result;
  const cutoffDay = dayKey(new Date(now.getTime() - auditRetentionDays * DAY_MS));
  for (const source of Object.keys(LOG_SOURCES) as LogSource[]) {
    const lastSealed = await db('audit_digests').where({ source }).max({ day: 'day' }).first();
    if (!lastSealed?.day) continue;
    const sealedDay = typeof lastSealed.day === 'string' ? lastSealed.day : dayKey(new Date(lastSealed.day));
    const before = startOf(cutoffDay <= addDays(sealedDay, 1) ? cutoffDay : addDays(sealedDay, 1));
    for (;;) {
      const n = await db.transaction(async (trx) => {
        await trx.raw('SET @audit_purge = 1');
        try {
          const ids = await trx(LOG_SOURCES[source])
            .where('created_at', '<', before)
            .orderBy('id')
            .limit(BATCH)
            .pluck('id');
          if (ids.length) await trx(LOG_SOURCES[source]).whereIn('id', ids).delete();
          return ids.length;
        } finally {
          await trx.raw('SET @audit_purge = 0');
        }
      });
      result[source] += n;
      if (n < BATCH) break;
    }
    if (result[source]) {
      await db.transaction(async (trx) => {
        await trx('audit_digests')
          .where({ source })
          .where('day', '<', dayKey(before))
          .whereNull('purged_at')
          .update({ purged_at: new Date() });
        await audit(trx, systemContext('retention'), {
          action: 'audit.purged',
          entity: 'audit_log',
          diff: {
            source,
            before: before.toISOString(),
            deleted: result[source],
            retentionDays: auditRetentionDays,
          },
        });
      });
    }
  }
  return result;
}

/** Hourly: seal finished days, then apply retention. */
export async function maintainAuditLogs() {
  for (const source of Object.keys(LOG_SOURCES) as LogSource[]) await sealPendingDays(source);
  await purgeExpiredLogs();
}
