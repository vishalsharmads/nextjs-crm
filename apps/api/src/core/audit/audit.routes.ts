import { z } from 'zod';
import type { Knex } from 'knex';
import type { Response } from 'express';
import { stringify } from 'csv-stringify';
import { CUSTOMIZABLE_ENTITIES, type CustomizableEntity, type VisibilityLevel } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { db } from '../../db/knex';
import { notFound } from '../../lib/errors';
import { escapeLike } from '../records/filters';
import { recordDefs } from '../records/registry';
import { scopedQuery } from '../records/service';
import { can } from '../rbac/access';
import { fieldAccessMap, getDefinitions } from '../custom-fields/definitions';
import { redactDiff } from '../records/custom';
import { audit } from './audit.service';
import { logAccess } from './access-log';
import { verifyIntegrity } from './integrity';
import { csvSafe } from '../../lib/csv';
import { verifyLimiter } from '../../middleware/rate-limit';

const EXPORT_MAX_ROWS = 100_000;

const auditFilters = z.object({
  entity: z.string().max(64).optional(),
  entityUuid: z.uuid().optional(),
  action: z.string().max(64).optional(),
  actor: z.uuid().optional(),
  ip: z.string().max(64).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
const page = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
};
type Filters = z.infer<typeof auditFilters>;

/** Filters shared by both logs. Mutates `qb` (a returned builder would run). */
function applyFilters(qb: Knex.QueryBuilder, f: Filters, table: 'a' | 'x') {
  if (f.entity) qb.where(`${table}.entity`, f.entity);
  if (f.entityUuid) qb.where(`${table}.entity_uuid`, f.entityUuid);
  if (f.action) qb.where(`${table}.action`, 'like', `${escapeLike(f.action)}%`);
  if (f.actor) qb.where('u.uuid', f.actor);
  if (f.ip) qb.where(`${table}.ip`, f.ip);
  if (f.from) qb.where(`${table}.created_at`, '>=', new Date(f.from));
  if (f.to) qb.where(`${table}.created_at`, '<=', new Date(f.to));
}

/**
 * Custom fields hidden from the viewer are removed from diffs at read time. Rows were already
 * redacted for the actor when written; this covers viewers who see less than the actor did.
 */
async function viewerRedactor(user: AuthUser) {
  const levels = new Map<string, Record<string, VisibilityLevel>>();
  for (const e of CUSTOMIZABLE_ENTITIES) levels.set(e, fieldAccessMap(await getDefinitions(e), user));
  return (entity: string, diff: unknown) => {
    const l = levels.get(entity as CustomizableEntity);
    return l && diff && typeof diff === 'object' && !Array.isArray(diff)
      ? redactDiff(diff as Record<string, unknown>, l)
      : diff;
  };
}

const actorName = (r: Record<string, unknown>) =>
  r.actor_uuid
    ? `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim() || String(r.email)
    : null;

function auditDto(r: Record<string, unknown>, redact: (entity: string, diff: unknown) => unknown) {
  return {
    id: r.id as number,
    action: r.action as string,
    entity: r.entity as string,
    entityUuid: (r.entity_uuid as string | null) ?? null,
    actor: r.actor_uuid ? { uuid: r.actor_uuid as string, name: actorName(r)! } : null,
    actorType: r.actor_type as string,
    diff: redact(r.entity as string, r.diff),
    ip: (r.ip as string | null) ?? null,
    requestId: (r.request_id as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

function accessDto(r: Record<string, unknown>) {
  return {
    id: r.id as number,
    action: r.action as string,
    entity: r.entity as string,
    entityUuid: (r.entity_uuid as string | null) ?? null,
    actor: r.actor_uuid ? { uuid: r.actor_uuid as string, name: actorName(r)! } : null,
    actorType: r.actor_type as string,
    detail: r.detail ?? null,
    ip: (r.ip as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

const ACTOR_COLS = ['u.uuid as actor_uuid', 'u.first_name', 'u.last_name', 'u.email'];

/** Stream rows newest first, in id pages, up to EXPORT_MAX_ROWS. */
async function streamCsv(
  res: Response,
  name: string,
  header: string[],
  qb: Knex.QueryBuilder,
  alias: string,
  toRow: (r: Record<string, unknown>) => unknown[],
  /** Runs before the response ends, so the export is recorded before the client has the file. */
  record: (count: number) => Promise<void>,
) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.csv"`);
  const csv = stringify({ header: true, columns: header, bom: true });
  csv.pipe(res);
  let count = 0;
  let beforeId: number | null = null;
  while (count < EXPORT_MAX_ROWS) {
    const pageQb = qb.clone().orderBy(`${alias}.id`, 'desc').limit(1000);
    if (beforeId !== null) pageQb.where(`${alias}.id`, '<', beforeId);
    const rows = (await pageQb) as Record<string, unknown>[];
    for (const r of rows) csv.write(toRow(r).map(csvSafe));
    count += rows.length;
    if (rows.length < 1000) break;
    beforeId = rows[rows.length - 1]!.id as number;
  }
  await record(count);
  await new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    csv.end();
  });
}

/**
 * Entries about core records follow the viewer's record scope: someone who sees only their own
 * contacts sees only those contacts' history. Workspace entries (settings, sign-ins) are not
 * record data and stay visible to every audit viewer. Mutates `qb`.
 */
async function applyRecordScope(qb: Knex.QueryBuilder, user: AuthUser, alias: 'a' | 'x') {
  if (user.isAdmin) return;
  const limited: [string, Knex.QueryBuilder | null][] = [];
  for (const [entity, def] of Object.entries(recordDefs)) {
    const canView = can(user, `${def.resource}.view`);
    if (canView && user.scopes[def.resource] === 'all') continue;
    let sub: Knex.QueryBuilder | null = null;
    if (canView) {
      ({ qb: sub } = await scopedQuery(def, user, db, 'with'));
      sub.select(`${def.table}.id`);
    }
    limited.push([entity, sub]);
  }
  if (!limited.length) return;
  qb.where((w) => {
    w.whereNotIn(
      `${alias}.entity`,
      limited.map(([e]) => e),
    );
    for (const [entity, sub] of limited)
      if (sub) w.orWhere((o) => o.where(`${alias}.entity`, entity).whereIn(`${alias}.entity_id`, sub));
  });
}

const auditQuery = async (f: Filters, user: AuthUser) => {
  const qb = db('audit_logs as a').leftJoin('users as u', 'u.id', 'a.actor_id');
  applyFilters(qb, f, 'a');
  await applyRecordScope(qb, user, 'a');
  return { qb };
};
const accessQuery = async (f: Filters, user: AuthUser) => {
  const qb = db('access_logs as x').leftJoin('users as u', 'u.id', 'x.actor_id');
  applyFilters(qb, f, 'x');
  await applyRecordScope(qb, user, 'x');
  return { qb };
};

export const auditRoutes = defineRoutes('/audit-logs', ['audit'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.audit.view',
    query: auditFilters.extend(page),
    handler: async ({ ctx, user, query }) => {
      const { qb } = await auditQuery(query, user);
      const total = Number(((await qb.clone().count({ c: '*' }).first()) as { c: number }).c);
      const rows = await qb
        .orderBy('a.id', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .select('a.*', ...ACTOR_COLS);
      const redact = await viewerRedactor(user);
      await logAccess(ctx, {
        action: 'audit_view',
        entity: 'audit_log',
        detail: { filters: filterDetail(query) },
      });
      return {
        data: rows.map((r) => auditDto(r, redact)),
        meta: { page: query.page, pageSize: query.pageSize, total },
      };
    },
  })
  .add({
    method: 'get',
    path: '/export',
    permission: 'core.audit.export',
    query: auditFilters,
    summary: 'CSV of matching audit entries, newest first (at most 100,000 rows)',
    handler: async ({ ctx, user, query, res }) => {
      const { qb } = await auditQuery(query, user);
      qb.select('a.*', ...ACTOR_COLS);
      const redact = await viewerRedactor(user);
      await streamCsv(
        res,
        'audit-log',
        [
          'Time (UTC)',
          'Actor',
          'Actor type',
          'Action',
          'Entity',
          'Record',
          'IP address',
          'Request',
          'Details',
        ],
        qb,
        'a',
        (r) => {
          const d = auditDto(r, redact);
          return [
            d.createdAt,
            d.actor?.name ?? '',
            d.actorType,
            d.action,
            d.entity,
            d.entityUuid ?? '',
            d.ip ?? '',
            d.requestId ?? '',
            d.diff === null ? '' : JSON.stringify(d.diff),
          ];
        },
        async (count) => {
          await audit(db, ctx, {
            action: 'audit.exported',
            entity: 'audit_log',
            diff: { count, filters: filterDetail(query) },
          });
          await logAccess(ctx, { action: 'export', entity: 'audit_log', detail: { count } });
        },
      );
    },
  })
  .add({
    method: 'post',
    path: '/verify',
    permission: 'core.audit.view',
    // Rescans every sealed day: a few per minute is plenty.
    before: [verifyLimiter],
    summary: 'Recompute the sealed daily digests of the audit and access logs',
    handler: async ({ ctx }) => {
      const result = await verifyIntegrity();
      await audit(db, ctx, {
        action: 'audit.verified',
        entity: 'audit_log',
        diff: { daysChecked: result.daysChecked, problems: result.problems.length },
      });
      return result;
    },
  })
  .add({
    method: 'get',
    path: '/:id',
    permission: 'core.audit.view',
    params: z.object({ id: z.coerce.number().int().positive() }),
    handler: async ({ ctx, user, params }) => {
      const { qb } = await auditQuery({}, user);
      const row = await qb.where('a.id', params.id).first('a.*', ...ACTOR_COLS);
      if (!row) throw notFound('Audit entry');
      await logAccess(ctx, { action: 'audit_view', entity: 'audit_log', entityId: params.id });
      return auditDto(row, await viewerRedactor(user));
    },
  });

export const accessLogRoutes = defineRoutes('/access-logs', ['audit'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.audit.view',
    query: auditFilters.extend(page),
    handler: async ({ ctx, user, query }) => {
      const { qb } = await accessQuery(query, user);
      const total = Number(((await qb.clone().count({ c: '*' }).first()) as { c: number }).c);
      const rows = await qb
        .orderBy('x.id', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .select('x.*', ...ACTOR_COLS);
      await logAccess(ctx, {
        action: 'audit_view',
        entity: 'access_log',
        detail: { filters: filterDetail(query) },
      });
      return { data: rows.map(accessDto), meta: { page: query.page, pageSize: query.pageSize, total } };
    },
  })
  .add({
    method: 'get',
    path: '/export',
    permission: 'core.audit.export',
    query: auditFilters,
    summary: 'CSV of matching access log entries, newest first (at most 100,000 rows)',
    handler: async ({ ctx, user, query, res }) => {
      const { qb } = await accessQuery(query, user);
      qb.select('x.*', ...ACTOR_COLS);
      await streamCsv(
        res,
        'access-log',
        ['Time (UTC)', 'Actor', 'Actor type', 'Action', 'Entity', 'Record', 'IP address', 'Details'],
        qb,
        'x',
        (r) => {
          const d = accessDto(r);
          return [
            d.createdAt,
            d.actor?.name ?? '',
            d.actorType,
            d.action,
            d.entity,
            d.entityUuid ?? '',
            d.ip ?? '',
            d.detail === null ? '' : JSON.stringify(d.detail),
          ];
        },
        async (count) => {
          await audit(db, ctx, {
            action: 'access_log.exported',
            entity: 'access_log',
            diff: { count, filters: filterDetail(query) },
          });
          await logAccess(ctx, { action: 'export', entity: 'access_log', detail: { count } });
        },
      );
    },
  });

/** Filters as recorded in the logs (without paging). */
function filterDetail(f: Filters) {
  const { entity, entityUuid, action, actor, ip, from, to } = f;
  return Object.fromEntries(
    Object.entries({ entity, entityUuid, action, actor, ip, from, to }).filter(([, v]) => v !== undefined),
  );
}
