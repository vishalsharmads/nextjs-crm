import { z } from 'zod';
import { FIELD_KEY_RE } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import type { AuthUser } from '../../http/context';
import { audit } from '../audit/audit.service';
import { applyScope, can } from '../rbac/access';
import { recordDefs } from '../records/registry';
import { getDefinition } from '../custom-fields/definitions';
import { isModuleEnabled } from '../../modules/registry';
import { moduleWidget } from '../../modules/widgets';

const widgetSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  type: z.string().regex(/^([a-z][a-z0-9-]*:)?[a-z][a-z0-9_.-]*$/),
  title: z.string().max(100).optional(),
  size: z.enum(['sm', 'md', 'lg']).default('md'),
  params: z.record(z.string(), z.unknown()).default({}),
});

const dto = (d: Record<string, unknown>, user: AuthUser) => ({
  uuid: d.uuid,
  name: d.name,
  widgets: d.widgets,
  isDefault: !!d.is_default,
  mine: d.owner_id === user.id,
  shared: d.owner_id === null,
});

async function dealsQuery(user: AuthUser) {
  const qb = db('deals').whereNull('deals.deleted_at');
  await applyScope(qb, user, 'core.deals', ['deals.owner_id']);
  return { qb };
}

/** Widget data. Every query runs inside the viewer's record scope. */
async function widgetData(type: string, params: Record<string, unknown>, user: AuthUser): Promise<unknown> {
  if (type.startsWith('module:')) {
    const [moduleKey] = type.slice(7).split('.');
    if (!moduleKey || !isModuleEnabled(moduleKey)) return { unavailable: true, reason: 'module_disabled' };
    return moduleWidget(type.slice(7), params, user);
  }
  switch (type) {
    case 'pipeline_value': {
      if (!can(user, 'core.deals.view')) return { unavailable: true, reason: 'forbidden' };
      const pipeline =
        typeof params.pipeline === 'string'
          ? await db('pipelines')
              .where({ source_key: `pipeline.${params.pipeline}` })
              .orWhere({ uuid: params.pipeline })
              .first()
          : await db('pipelines').where({ entity: 'deal', is_default: true }).first();
      if (!pipeline) return { stages: [], total: 0, weighted: 0 };
      const stages = await db('pipeline_stages')
        .where({ pipeline_id: pipeline.id, active: true, is_won: false, is_lost: false })
        .orderBy('sort_order');
      const { qb } = await dealsQuery(user);
      const rows = await qb
        .where('deals.pipeline_id', pipeline.id)
        .where('deals.status', 'open')
        .groupBy('deals.stage_id')
        .select('deals.stage_id')
        .count({ n: '*' })
        .sum({ v: 'deals.value' });
      const byStage = new Map(
        (rows as { stage_id: number; n: number; v: number }[]).map((r) => [r.stage_id, r]),
      );
      const data = stages.map((s) => ({
        name: s.name,
        probability: s.probability,
        count: Number(byStage.get(s.id)?.n ?? 0),
        value: Number(byStage.get(s.id)?.v ?? 0),
      }));
      return {
        pipeline: pipeline.name,
        stages: data,
        total: data.reduce((a, s) => a + s.value, 0),
        weighted: Math.round(data.reduce((a, s) => a + (s.value * s.probability) / 100, 0)),
        count: data.reduce((a, s) => a + s.count, 0),
      };
    }
    case 'tasks_due': {
      const now = new Date();
      const soon = new Date(now.getTime() + 7 * 86_400_000);
      const base = db('activities')
        .whereNull('deleted_at')
        .whereNull('completed_at')
        .whereNot('type', 'note')
        .where('assignee_id', user.id);
      const overdue = await base.clone().where('due_at', '<', now).count({ c: '*' }).first();
      const upcoming = await base
        .clone()
        .where('due_at', '>=', now)
        .where('due_at', '<=', soon)
        .count({ c: '*' })
        .first();
      const next = await base
        .clone()
        .whereNotNull('due_at')
        .orderBy('due_at')
        .limit(6)
        .select('uuid', 'subject', 'type', 'due_at');
      return {
        overdue: Number((overdue as { c: number }).c),
        upcoming: Number((upcoming as { c: number }).c),
        next: next.map((n) => ({
          uuid: n.uuid,
          subject: n.subject,
          type: n.type,
          dueAt: new Date(n.due_at).toISOString(),
          overdue: new Date(n.due_at) < now,
        })),
      };
    }
    case 'conversion': {
      if (!can(user, 'core.deals.view')) return { unavailable: true, reason: 'forbidden' };
      const days = Math.min(Math.max(Number(params.days ?? 90), 1), 730);
      const since = new Date(Date.now() - days * 86_400_000);
      const { qb } = await dealsQuery(user);
      const won = await qb
        .clone()
        .where('deals.won_at', '>=', since)
        .count({ c: '*' })
        .sum({ v: 'deals.value' })
        .first();
      const lost = await qb.clone().where('deals.lost_at', '>=', since).count({ c: '*' }).first();
      const created = await qb.clone().where('deals.created_at', '>=', since).count({ c: '*' }).first();
      const w = Number((won as { c: number }).c);
      const l = Number((lost as { c: number }).c);
      return {
        days,
        won: w,
        lost: l,
        created: Number((created as { c: number }).c),
        wonValue: Number((won as { v: number | null }).v ?? 0),
        winRate: w + l ? Math.round((w / (w + l)) * 100) : null,
      };
    }
    case 'activity_by_user': {
      const days = Math.min(Math.max(Number(params.days ?? 30), 1), 365);
      const qb = db('activities as a')
        .join('users as u', 'u.id', 'a.assignee_id')
        .whereNull('a.deleted_at')
        .whereNotNull('a.completed_at')
        .where('a.completed_at', '>=', new Date(Date.now() - days * 86_400_000));
      await applyScope(qb, user, 'core.activities', ['a.assignee_id', 'a.owner_id']);
      const rows = await qb
        .groupBy('u.id', 'a.type')
        .select('u.first_name', 'u.last_name', 'a.type')
        .count({ n: '*' });
      const byUser = new Map<string, Record<string, number>>();
      for (const r of rows as { first_name: string; last_name: string; type: string; n: number }[]) {
        const name = `${r.first_name} ${r.last_name}`.trim();
        const entry = byUser.get(name) ?? {};
        entry[r.type] = Number(r.n);
        byUser.set(name, entry);
      }
      return {
        days,
        users: [...byUser.entries()]
          .map(([name, counts]) => ({
            name,
            ...counts,
            total: Object.values(counts).reduce((a, b) => a + b, 0),
          }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 10),
      };
    }
    case 'date_window': {
      const entity = String(params.entity ?? 'deal') as 'deal' | 'contact' | 'organization' | 'lead';
      const def = recordDefs[entity];
      if (!def || !can(user, `${def.resource}.view`)) return { unavailable: true, reason: 'forbidden' };
      const days = Math.min(Math.max(Number(params.days ?? 30), 1), 365);
      const field = String(params.field ?? '');
      let column: string;
      if (field.startsWith('cf.')) {
        const fd = await getDefinition(entity, field.slice(3));
        if (!fd?.filterable || !FIELD_KEY_RE.test(fd.key))
          return { unavailable: true, reason: 'field_not_filterable' };
        column = `${def.table}.cf_${fd.key}`;
      } else if (field === 'expected_close' && entity === 'deal') column = 'deals.expected_close';
      else throw new AppError('VALIDATION_FAILED', 'Unsupported date field');
      const qb = db(def.table)
        .whereNull(`${def.table}.deleted_at`)
        .whereBetween(column, [
          new Date().toISOString().slice(0, 10),
          new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10),
        ]);
      await applyScope(qb, user, def.resource, def.ownerColumns);
      if (entity === 'deal' && typeof params.status === 'string') qb.where('deals.status', params.status);
      const total = await qb.clone().count({ c: '*' }).first();
      const rows = await qb
        .orderBy(column)
        .limit(8)
        .select(`${def.table}.*`, db.raw('?? as window_date', [column]));
      const dtos = (await def.toDtos(rows, { user, conn: db })) as {
        uuid: string;
        title?: string;
        fullName?: string;
        name?: string;
      }[];
      return {
        days,
        total: Number((total as { c: number }).c),
        items: dtos.map((d, i) => ({
          uuid: d.uuid,
          title: d.title ?? d.fullName ?? d.name ?? '',
          date: String(rows[i].window_date).slice(0, 10),
        })),
        route: entity,
      };
    }
    default:
      return { unavailable: true, reason: 'unknown_widget' };
  }
}

export const dashboardRoutes = defineRoutes('/dashboards', ['dashboard'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.dashboard.view',
    summary: 'The shared default dashboard plus my personal ones',
    handler: async ({ user }) => {
      const rows = await db('dashboards')
        .where((w) => w.whereNull('owner_id').orWhere({ owner_id: user.id }))
        .orderBy([{ column: 'owner_id', order: 'desc' }, { column: 'id' }]);
      return { data: rows.map((r) => dto(r, user)) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.dashboard.view',
    body: z.object({ name: z.string().trim().min(1).max(100), widgets: z.array(widgetSchema).max(30) }),
    status: 201,
    handler: async ({ ctx, user, body }) => {
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('dashboards').insert({
          uuid,
          name: body.name,
          owner_id: user.id,
          widgets: JSON.stringify(body.widgets),
          customized: true,
        });
        await audit(trx, ctx, {
          action: 'dashboard.created',
          entity: 'dashboard',
          entityId: id,
          entityUuid: uuid,
        });
      });
      return dto(await db('dashboards').where({ uuid }).first(), user);
    },
  })
  .add({
    method: 'put',
    path: '/:uuid',
    permission: 'core.dashboard.view',
    params: z.object({ uuid: z.uuid() }),
    body: z.object({
      name: z.string().trim().min(1).max(100).optional(),
      widgets: z.array(widgetSchema).max(30),
    }),
    handler: async ({ ctx, user, params, body }) => {
      const d = await db('dashboards').where({ uuid: params.uuid }).first();
      if (!d || (d.owner_id !== null && d.owner_id !== user.id)) throw notFound('Dashboard');
      if (d.owner_id === null && !can(user, 'core.dashboard.manage'))
        throw new AppError(
          'FORBIDDEN',
          'Only managers can change the shared dashboard. Save a copy instead.',
        );
      await db.transaction(async (trx) => {
        await trx('dashboards')
          .where({ id: d.id })
          .update({
            widgets: JSON.stringify(body.widgets),
            ...(body.name ? { name: body.name } : {}),
            customized: true,
          });
        await audit(trx, ctx, {
          action: 'dashboard.updated',
          entity: 'dashboard',
          entityId: d.id,
          entityUuid: params.uuid,
        });
      });
      return dto(await db('dashboards').where({ id: d.id }).first(), user);
    },
  })
  .add({
    method: 'get',
    path: '/widgets/:type/data',
    permission: 'core.dashboard.view',
    params: z.object({ type: z.string().regex(/^([a-z][a-z0-9-]*:)?[a-z][a-z0-9_.-]*$/) }),
    query: z.object({ params: z.string().max(2000).optional() }),
    handler: async ({ user, params, query }) =>
      widgetData(
        params.type,
        query.params ? (JSON.parse(query.params) as Record<string, unknown>) : {},
        user,
      ),
  });
