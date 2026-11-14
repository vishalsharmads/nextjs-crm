import type { Knex } from 'knex';
import {
  forecastQuerySchema,
  quotaInputSchema,
  quotaQuerySchema,
  velocityQuerySchema,
  exchangeRatesInputSchema,
  type ExchangeRatesDto,
  type ForecastDto,
  type QuotaRowDto,
  type VelocityDto,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import { assertCan, can, teamUserIds } from '../rbac/access';
import { scopedQuery } from '../records/service';
import { recordDefs } from '../records/registry';
import { getGroup } from '../settings/settings.service';
import { standardLevels } from '../custom-fields/standard-visibility';

const DAY = 86_400_000;
const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Deals the user may see, in one currency and optionally one pipeline. Every report starts here,
 * so record scope applies to forecasts, quotas and velocity exactly as to the deal list.
 */
async function deals(
  user: AuthUser,
  q: { pipelineUuid?: string | undefined; currency?: string | undefined; convert?: boolean | undefined },
) {
  assertCan(user, 'core.reports.view');
  assertCan(user, `${recordDefs.deal.resource}.view`);
  // Every sales report is built from deal values: none for people the value is hidden from.
  if ((await standardLevels('deal', user)).value === 'hidden')
    throw new AppError('FORBIDDEN', 'Deal values are hidden for your role');
  const base = (await getGroup('general')).currency;
  const currency = q.convert ? base : (q.currency ?? base);
  const { qb } = await scopedQuery(recordDefs.deal, user, db);
  // Converted reports count every currency that has a rate (the workspace currency is 1:1).
  const rate = db.raw('CASE WHEN deals.currency = ? THEN 1 ELSE er.rate END', [base]);
  let missingRates: string[] | undefined;
  if (q.convert) {
    qb.leftJoin('exchange_rates as er', 'er.currency', 'deals.currency');
    missingRates = (
      await qb.clone().whereRaw('? IS NULL', [rate]).distinct('deals.currency').pluck('deals.currency')
    ).map(String);
    qb.whereRaw('? IS NOT NULL', [rate]);
  } else qb.where('deals.currency', currency);
  /** The deal value in the report currency, as a select expression aliased `value`. */
  const value = q.convert ? db.raw('deals.value * ? AS value', [rate]) : 'deals.value';
  const sum = q.convert ? db.raw('SUM(deals.value * ?) AS v', [rate]) : db.raw('SUM(deals.value) AS v');
  if (q.pipelineUuid) {
    const p = await db('pipelines').where({ uuid: q.pipelineUuid }).first('id');
    if (!p) throw notFound('Pipeline');
    qb.where('deals.pipeline_id', p.id);
  }
  return { qb, currency, value, sum, missingRates };
}

async function forecast(
  user: AuthUser,
  q: { months: number; pipelineUuid?: string; currency?: string; convert?: boolean },
) {
  // Buckets by expected close month: not for people that date is hidden from.
  if ((await standardLevels('deal', user)).expected_close === 'hidden')
    throw new AppError('FORBIDDEN', 'Expected close dates are hidden for your role');
  const open = await deals(user, q);
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await open.qb
    .clone()
    .join('pipeline_stages as s', 's.id', 'deals.stage_id')
    .where('deals.status', 'open')
    .select(open.value, 'deals.expected_close', 's.probability')) as {
    value: string;
    expected_close: string | null;
    probability: number;
  }[];
  const start = new Date();
  start.setUTCDate(1);
  const months: ForecastDto['months'] = [];
  for (let i = 0; i < q.months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    months.push({ month: monthOf(d), count: 0, value: 0, weighted: 0, won: 0 });
  }
  const out: ForecastDto = {
    currency: open.currency,
    ...(open.missingRates ? { missingRates: open.missingRates } : {}),
    overdue: { count: 0, value: 0, weighted: 0 },
    months,
    undated: { count: 0, value: 0 },
  };
  for (const r of rows) {
    const value = Number(r.value);
    const weighted = (value * r.probability) / 100;
    if (!r.expected_close) {
      out.undated.count++;
      out.undated.value += value;
      continue;
    }
    if (r.expected_close < today) {
      out.overdue.count++;
      out.overdue.value += value;
      out.overdue.weighted += weighted;
      continue;
    }
    const bucket = months.find((m) => m.month === r.expected_close!.slice(0, 7));
    if (!bucket) continue;
    bucket.count++;
    bucket.value += value;
    bucket.weighted += weighted;
  }
  const wonBase = await deals(user, q);
  const won = (await wonBase.qb
    .where('deals.status', 'won')
    .where('deals.won_at', '>=', new Date(`${months[0]!.month}-01T00:00:00Z`))
    .select(wonBase.value, 'deals.won_at')) as { value: string; won_at: Date }[];
  for (const w of won) {
    const bucket = months.find((m) => m.month === monthOf(new Date(w.won_at)));
    if (bucket) bucket.won += Number(w.value);
  }
  for (const m of months)
    Object.assign(m, { value: money(m.value), weighted: money(m.weighted), won: money(m.won) });
  out.overdue = { ...out.overdue, value: money(out.overdue.value), weighted: money(out.overdue.weighted) };
  out.undated.value = money(out.undated.value);
  return out;
}

async function velocity(
  user: AuthUser,
  q: { days: number; pipelineUuid?: string; currency?: string; convert?: boolean },
) {
  const since = new Date(Date.now() - q.days * DAY);
  const base = await deals(user, q);
  const closed = (await base.qb
    .clone()
    .where((w) =>
      w
        .where((x) => x.where('deals.status', 'won').where('deals.won_at', '>=', since))
        .orWhere((x) => x.where('deals.status', 'lost').where('deals.lost_at', '>=', since)),
    )
    .select('deals.status', base.value, 'deals.created_at', 'deals.won_at')) as {
    status: 'won' | 'lost';
    value: string;
    created_at: Date;
    won_at: Date | null;
  }[];
  const won = closed.filter((c) => c.status === 'won');
  const lost = closed.length - won.length;
  const openRow = (await base.qb.clone().where('deals.status', 'open').count({ n: '*' }).first()) as {
    n: number;
  };
  const open = Number(openRow?.n ?? 0);
  const winRate = closed.length ? won.length / closed.length : null;
  const avgWonValue = won.length ? won.reduce((s, w) => s + Number(w.value), 0) / won.length : null;
  const avgCycleDays = won.length
    ? won.reduce((s, w) => s + (new Date(w.won_at!).getTime() - new Date(w.created_at).getTime()) / DAY, 0) /
      won.length
    : null;
  const velocityPerDay =
    winRate !== null && avgWonValue !== null && avgCycleDays
      ? (open * winRate * avgWonValue) / Math.max(avgCycleDays, 1)
      : null;

  // Time spent in each stage: from entering it to the next change, for changes in the window.
  const ids = base.qb.clone().clearSelect().select('deals.id');
  const history = (await db('deal_stage_history')
    .whereIn('deal_id', ids as unknown as Knex.QueryBuilder)
    .where('changed_at', '>=', since)
    .orderBy(['deal_id', 'changed_at', 'id'])
    .select('deal_id', 'to_stage_id', 'changed_at')) as {
    deal_id: number;
    to_stage_id: number;
    changed_at: Date;
  }[];
  const spent = new Map<number, { total: number; done: number; entered: number }>();
  for (let i = 0; i < history.length; i++) {
    const h = history[i]!;
    const s = spent.get(h.to_stage_id) ?? { total: 0, done: 0, entered: 0 };
    s.entered++;
    const next = history[i + 1];
    if (next && next.deal_id === h.deal_id) {
      s.total += (new Date(next.changed_at).getTime() - new Date(h.changed_at).getTime()) / DAY;
      s.done++;
    }
    spent.set(h.to_stage_id, s);
  }
  const stageQuery = db('pipeline_stages as s')
    .join('pipelines as p', 'p.id', 's.pipeline_id')
    .where('p.entity', 'deal')
    .where('s.active', true)
    .orderBy(['p.sort_order', 's.sort_order'])
    .select('s.id', 's.uuid', 's.name');
  if (q.pipelineUuid) stageQuery.where('p.uuid', q.pipelineUuid);
  const stages = (await stageQuery) as { id: number; uuid: string; name: string }[];
  const round = (v: number | null, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
  return {
    currency: base.currency,
    ...(base.missingRates ? { missingRates: base.missingRates } : {}),
    days: q.days,
    won: won.length,
    lost,
    winRate: round(winRate, 3),
    avgWonValue: round(avgWonValue, 2),
    avgCycleDays: round(avgCycleDays),
    open,
    velocityPerDay: round(velocityPerDay, 2),
    stages: stages.map((s) => {
      const v = spent.get(s.id);
      return {
        uuid: s.uuid,
        name: s.name,
        avgDays: v?.done ? round(v.total / v.done) : null,
        entered: v?.entered ?? 0,
      };
    }),
  } satisfies VelocityDto;
}

/** People whose numbers the user may see: everyone with `all` deal scope, else their team or themselves. */
async function visibleUsers(user: AuthUser) {
  const scope = user.isAdmin ? 'all' : (user.scopes[recordDefs.deal.resource] ?? 'own');
  const q = db('users')
    .whereNull('deleted_at')
    .where('status', 'active')
    .orderBy(['first_name', 'last_name']);
  if (scope === 'team') q.whereIn('id', await teamUserIds(user.id));
  if (scope === 'own') q.where('id', user.id);
  return (await q.select('id', 'uuid', 'first_name', 'last_name')) as {
    id: number;
    uuid: string;
    first_name: string;
    last_name: string;
  }[];
}

async function quotas(
  user: AuthUser,
  q: { period: string; currency?: string; convert?: boolean },
): Promise<{ currency: string; data: QuotaRowDto[] }> {
  const { qb, currency, sum } = await deals(user, q);
  const people = await visibleUsers(user);
  const ids = people.map((p) => p.id);
  const start = new Date(`${q.period}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const won = (await qb
    .clone()
    .whereIn('deals.owner_id', ids)
    .where('deals.status', 'won')
    .where('deals.won_at', '>=', start)
    .where('deals.won_at', '<', end)
    .groupBy('deals.owner_id')
    .select('deals.owner_id', sum)) as { owner_id: number; v: string }[];
  const open = (await qb
    .clone()
    .whereIn('deals.owner_id', ids)
    .where('deals.status', 'open')
    .groupBy('deals.owner_id')
    .select('deals.owner_id', sum)) as { owner_id: number; v: string }[];
  const targets = (await db('sales_quotas')
    .whereIn('user_id', ids)
    .where({ period: q.period, currency })
    .select('user_id', 'amount')) as { user_id: number; amount: string }[];
  return {
    currency,
    data: people.map((p) => {
      const quota = targets.find((t) => t.user_id === p.id);
      const w = money(won.find((x) => x.owner_id === p.id)?.v);
      return {
        user: { uuid: p.uuid, name: `${p.first_name} ${p.last_name}`.trim() },
        quota: quota ? money(quota.amount) : null,
        won: w,
        attainment:
          quota && Number(quota.amount) > 0 ? Math.round((w / Number(quota.amount)) * 1000) / 1000 : null,
        openPipeline: money(open.find((x) => x.owner_id === p.id)?.v),
      };
    }),
  };
}

export const reportsRoutes = defineRoutes('/reports', ['reports'])
  .add({
    method: 'get',
    path: '/forecast',
    permission: 'core.reports.view',
    query: forecastQuerySchema,
    summary: 'Open pipeline by expected close month, weighted by stage probability, with won value',
    handler: ({ user, query }) => forecast(user, query),
  })
  .add({
    method: 'get',
    path: '/velocity',
    permission: 'core.reports.view',
    query: velocityQuerySchema,
    summary: 'Win rate, deal size, cycle length, sales velocity and time in each stage',
    handler: ({ user, query }) => velocity(user, query),
  })
  .add({
    method: 'get',
    path: '/quotas',
    permission: 'core.reports.view',
    query: quotaQuerySchema,
    summary: 'Quota attainment per person for a month',
    handler: ({ user, query }) => quotas(user, query),
  })
  .add({
    method: 'put',
    path: '/quotas',
    permission: 'core.quotas.manage',
    body: quotaInputSchema,
    handler: async ({ ctx, user, body }) => {
      assertCan(user, 'core.reports.view');
      // Only for people whose numbers the manager can see (their own, their team's, or everyone's).
      const target = (await visibleUsers(user)).find((p) => p.uuid === body.userUuid);
      if (!target) throw notFound('Person');
      // Quotas are in the workspace currency, so attainment compares like with like.
      const { currency } = await getGroup('general');
      await db.transaction(async (trx) => {
        const before = await trx('sales_quotas').where({ user_id: target.id, period: body.period }).first();
        if (body.amount === null) {
          if (!before) return;
          await trx('sales_quotas').where({ id: before.id }).delete();
        } else
          await trx('sales_quotas')
            .insert({
              user_id: target.id,
              period: body.period,
              amount: body.amount,
              currency,
              updated_by: user.id,
            })
            .onConflict(['user_id', 'period'])
            .merge({ amount: body.amount, currency, updated_by: user.id, updated_at: new Date() });
        await audit(trx, ctx, {
          action: body.amount === null ? 'quota.deleted' : 'quota.set',
          entity: 'sales_quota',
          entityUuid: target.uuid,
          diff: {
            period: body.period,
            from: before ? { amount: money(before.amount), currency: before.currency } : null,
            to: body.amount === null ? null : { amount: body.amount, currency },
          },
        });
      });
    },
  });

/** Settings → Currencies: rates reports use to convert deal values into the workspace currency. */
export const exchangeRatesRoutes = defineRoutes('/exchange-rates', ['reports'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    handler: async ({ user }): Promise<ExchangeRatesDto> => {
      if (!can(user, 'core.reports.view') && !can(user, 'core.settings.manage'))
        throw new AppError('FORBIDDEN', 'You do not have permission to do that');
      const rows = await db('exchange_rates').orderBy('currency');
      const last = rows.reduce<Date | null>((m, r) => (!m || r.updated_at > m ? r.updated_at : m), null);
      return {
        base: (await getGroup('general')).currency,
        rates: Object.fromEntries(rows.map((r) => [r.currency, Number(r.rate)])),
        updatedAt: last ? new Date(last).toISOString() : null,
      };
    },
  })
  .add({
    method: 'put',
    path: '/',
    permission: 'core.settings.manage',
    body: exchangeRatesInputSchema,
    handler: async ({ ctx, user, body }) => {
      const { currency: base } = await getGroup('general');
      // The workspace currency is always 1:1 and never stored.
      const entries = Object.entries(body.rates).filter(([c]) => c !== base);
      await db.transaction(async (trx) => {
        const before = await trx('exchange_rates').select('currency', 'rate');
        await trx('exchange_rates').delete();
        if (entries.length)
          await trx('exchange_rates').insert(
            entries.map(([currency, rate]) => ({ currency, rate, updated_by: user.id })),
          );
        await audit(trx, ctx, {
          action: 'exchange_rates.updated',
          entity: 'exchange_rates',
          diff: {
            from: Object.fromEntries(before.map((r) => [r.currency, Number(r.rate)])),
            to: Object.fromEntries(entries),
          },
        });
      });
    },
  });
