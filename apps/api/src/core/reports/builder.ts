import { z } from 'zod';
import {
  reportDefinitionSchema,
  savedReportInputSchema,
  toPatch,
  type ReportDefinition,
  type ReportResultDto,
  type SavedReportDto,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { assertCan, can } from '../rbac/access';
import { getRecordDef } from '../records/registry';
import { applyListCriteria, filterContext, scopedQuery } from '../records/service';
import type { CoreFieldSpec, ResourceDef } from '../records/types';
import { iso } from '../records/hydrate';
import { getGroup } from '../settings/settings.service';

/** Groups returned per report; the rest are summed into "Other". */
const MAX_GROUPS = 50;
/** Columns of a second grouping; the rest are summed into "Other". */
const MAX_SERIES = 8;

/** Relation targets a report may group by: configuration, never people's records (no name leaks). */
const GROUP_TABLES = new Set(['pipeline_stages', 'pipelines']);

const BUCKET_SQL: Record<ReportDefinition['dateBucket'], string> = {
  day: "DATE_FORMAT(??, '%Y-%m-%d')",
  week: "DATE_FORMAT(??, '%x-W%v')",
  month: "DATE_FORMAT(??, '%Y-%m')",
  quarter: "CONCAT(YEAR(??), '-Q', QUARTER(??))",
  year: 'CAST(YEAR(??) AS CHAR)',
};

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_FAILED', message, [{ path, message }]);

interface Grouping {
  /** SQL expression and its identifier bindings. */
  sql: string;
  bindings: string[];
  label: (keys: (string | null)[]) => Promise<Map<string, string>>;
}

/** How to group by a field, using only whitelisted columns (core specs or visible, indexed custom fields). */
async function grouping(def: ResourceDef, d: ReportDefinition, user: AuthUser): Promise<Grouping> {
  const fc = await filterContext(def, user);
  const field = d.groupBy;
  const date = (column: string): Grouping => {
    const tpl = BUCKET_SQL[d.dateBucket];
    return {
      sql: tpl,
      bindings: Array<string>(tpl.split('??').length - 1).fill(column),
      label: async (keys) => new Map(keys.filter(Boolean).map((k) => [k!, k!])),
    };
  };
  if (field.startsWith('cf.')) {
    const cf = fc.customDefs.find((x) => x.key === field.slice(3));
    if (!cf || fc.fieldLevels[cf.key] === 'hidden') throw invalid('groupBy', 'Unknown field');
    if (
      !cf.filterable ||
      cf.type === 'multi_select' ||
      ['text', 'textarea', 'url', 'email', 'phone'].includes(cf.type)
    )
      throw invalid('groupBy', `${cf.label} cannot be grouped`);
    const column = `${def.table}.cf_${cf.key}`;
    if (cf.type === 'date' || cf.type === 'datetime') return date(column);
    return {
      sql: '??',
      bindings: [column],
      label: async () => new Map(cf.options.map((o) => [o.key, o.label])),
    };
  }
  const spec: CoreFieldSpec | undefined = def.fields[field];
  if (!spec) throw invalid('groupBy', 'Unknown field');
  if (spec.kind === 'user') {
    const column =
      def.ownerColumns.find((c) => c.endsWith('owner_id') || c.endsWith('assignee_id')) ??
      def.ownerColumns[0]!;
    return {
      sql: '??',
      bindings: [column],
      label: async (keys) => {
        const ids = keys.filter(Boolean).map(Number);
        const users = ids.length
          ? await db('users').whereIn('id', ids).select('id', 'first_name', 'last_name')
          : [];
        return new Map(users.map((u) => [String(u.id), `${u.first_name} ${u.last_name}`.trim()]));
      },
    };
  }
  if (spec.kind === 'relation') {
    if (!spec.relation || !GROUP_TABLES.has(spec.relation.table))
      throw invalid('groupBy', 'This field cannot be grouped');
    const table = spec.relation.table;
    return {
      sql: '??',
      bindings: [spec.relation.column],
      label: async (keys) => {
        const ids = keys.filter(Boolean).map(Number);
        const rows = ids.length ? await db(table).whereIn('id', ids).select('id', 'name') : [];
        return new Map(rows.map((r) => [String(r.id), r.name as string]));
      },
    };
  }
  if (!spec.column || !['select', 'date', 'datetime', 'boolean'].includes(spec.kind))
    throw invalid('groupBy', 'This field cannot be grouped');
  if (spec.kind === 'date' || spec.kind === 'datetime') return date(spec.column);
  const options = def.meta?.columns.find((c) => c.key === field)?.options;
  return {
    sql: '??',
    bindings: [spec.column],
    label: async (keys) =>
      new Map(
        keys.filter((k) => k !== null).map((k) => [k!, options?.find((o) => o.value === k)?.label ?? k!]),
      ),
  };
}

/** Column to sum or average, and a divisor (module money columns are stored in cents). */
async function metricColumn(def: ResourceDef, d: ReportDefinition, user: AuthUser) {
  if (d.metric === 'count') return null;
  const field = d.metricField;
  if (!field) throw invalid('metricField', 'Choose a number field');
  if (field.startsWith('cf.')) {
    const fc = await filterContext(def, user);
    const cf = fc.customDefs.find((x) => x.key === field.slice(3));
    if (!cf || fc.fieldLevels[cf.key] === 'hidden') throw invalid('metricField', 'Unknown field');
    if (!cf.filterable || !['number', 'decimal', 'currency'].includes(cf.type))
      throw invalid('metricField', `${cf.label} is not a filterable number field`);
    return { column: `${def.table}.cf_${cf.key}`, divisor: 1 };
  }
  const spec = def.fields[field];
  if (!spec?.column || spec.kind !== 'number') throw invalid('metricField', 'Choose a number field');
  const money = def.meta?.columns.find((c) => c.key === field)?.kind === 'money';
  return { column: spec.column, divisor: money ? 100 : 1 };
}

/** Run a report as the user: their permission, record scope and field visibility apply. */
export async function runReport(raw: unknown, user: AuthUser): Promise<ReportResultDto> {
  const d = reportDefinitionSchema.parse(raw);
  const def = getRecordDef(d.entity);
  assertCan(user, `${def.resource}.view`);
  const group = await grouping(def, d, user);
  const metric = await metricColumn(def, d, user);
  const { qb } = await scopedQuery(def, user, db);
  if (d.filter) await applyListCriteria(qb, def, user, { filter: d.filter });
  // Money in several currencies: convert with the saved rates; rows without a rate are left out.
  const currencyColumn = def.fields.currency?.column;
  let measure = metric ? db.raw('??', [metric.column]) : null;
  let missingRates: string[] | undefined;
  if (d.convert && metric && currencyColumn) {
    const { currency: base } = await getGroup('general');
    qb.leftJoin('exchange_rates as er', 'er.currency', currencyColumn);
    const rate = db.raw('CASE WHEN ?? = ? THEN 1 ELSE er.rate END', [currencyColumn, base]);
    missingRates = (
      await qb.clone().whereRaw('? IS NULL', [rate]).distinct(currencyColumn).pluck(currencyColumn)
    ).map(String);
    qb.whereRaw('? IS NOT NULL', [rate]);
    measure = db.raw('?? * ?', [metric.column, rate]);
  }
  const aggregate = (alias: string) =>
    measure === null
      ? db.raw(`COUNT(*) AS ${alias}`)
      : db.raw(`${d.metric === 'sum' ? 'SUM' : 'AVG'}(?) AS ${alias}`, [measure]);
  const rows = (await qb
    .clone()
    .select(db.raw(`${group.sql} AS k`, group.bindings), aggregate('v'))
    .groupByRaw(group.sql, group.bindings)
    .orderBy('v', 'desc')) as { k: string | number | null; v: string | number | null }[];
  const divisor = metric?.divisor ?? 1;
  const round = (v: unknown) => Math.round((Number(v ?? 0) / divisor) * 100) / 100;
  const keys = rows.map((r) => (r.k === null ? null : String(r.k)));
  const labels = await group.label(keys);
  const isDate = group.sql !== '??';
  let out: ReportResultDto['rows'] = rows.map((r, i) => ({
    key: keys[i]!,
    label: keys[i] === null ? 'None' : (labels.get(keys[i]!) ?? keys[i]!),
    value: round(r.v),
  }));
  // Dates read best in time order; categories by size.
  if (isDate) out.sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''));
  if (out.length > MAX_GROUPS) {
    const rest = out.slice(MAX_GROUPS - 1);
    out = [
      ...out.slice(0, MAX_GROUPS - 1),
      { key: '__other', label: 'Other', value: rest.reduce((s, r) => s + r.value, 0) },
    ];
  }

  // A second grouping breaks each row down: the largest series, the rest as "Other".
  let series: ReportResultDto['series'];
  if (d.groupBy2) {
    if (d.groupBy2 === d.groupBy) throw invalid('groupBy2', 'Choose a different field');
    const g2 = await grouping(def, { ...d, groupBy: d.groupBy2 }, user);
    const cells = (await qb
      .clone()
      .select(
        db.raw(`${group.sql} AS k`, group.bindings),
        db.raw(`${g2.sql} AS k2`, g2.bindings),
        aggregate('v'),
      )
      .groupByRaw(`${group.sql}, ${g2.sql}`, [...group.bindings, ...g2.bindings])) as {
      k: string | number | null;
      k2: string | number | null;
      v: string | number | null;
    }[];
    const str = (v: string | number | null) => (v === null ? '__none' : String(v));
    const totals = new Map<string, number>();
    for (const c of cells) totals.set(str(c.k2), (totals.get(str(c.k2)) ?? 0) + Number(c.v ?? 0));
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SERIES)
      .map(([k]) => k);
    const l2 = await g2.label(top.filter((k) => k !== '__none'));
    series = top.map((k) => ({ key: k, label: k === '__none' ? 'None' : (l2.get(k) ?? k) }));
    if (totals.size > MAX_SERIES) series.push({ key: '__other', label: 'Other' });
    const byRow = new Map(out.map((r) => [r.key ?? '__none', r]));
    for (const c of cells) {
      const row = byRow.get(str(c.k)) ?? byRow.get('__other');
      if (!row) continue;
      const col = top.includes(str(c.k2)) ? str(c.k2) : '__other';
      row.breakdown ??= {};
      // Averages are not additive: the "Other" cell of an average report shows the largest part.
      row.breakdown[col] =
        d.metric === 'avg'
          ? Math.max(row.breakdown[col] ?? 0, round(c.v))
          : (row.breakdown[col] ?? 0) + round(c.v);
    }
  }
  const total =
    d.metric === 'avg'
      ? out.length
        ? Math.round((out.reduce((s, r) => s + r.value, 0) / out.length) * 100) / 100
        : 0
      : Math.round(out.reduce((s, r) => s + r.value, 0) * 100) / 100;
  return {
    entity: d.entity,
    rows: out,
    total,
    ...(series ? { series } : {}),
    ...(missingRates ? { missingRates } : {}),
  };
}

const toDto = (r: Record<string, unknown>, user: AuthUser): SavedReportDto => ({
  uuid: r.uuid as string,
  name: r.name as string,
  definition: (typeof r.definition === 'string'
    ? JSON.parse(r.definition)
    : r.definition) as ReportDefinition,
  shared: !!r.shared,
  mine: r.owner_id === user.id,
  updatedAt: iso(r.updated_at)!,
});

/** Custom fields a definition names (group, metric, filter). */
function customKeys(d: ReportDefinition): string[] {
  const keys = [d.groupBy, d.groupBy2 ?? '', d.metricField ?? ''].filter((k) => k.startsWith('cf.'));
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const node = n as { field?: unknown; and?: unknown[]; or?: unknown[] };
    if (typeof node.field === 'string' && node.field.startsWith('cf.')) keys.push(node.field);
    for (const c of [...(node.and ?? []), ...(node.or ?? [])]) walk(c);
  };
  walk(d.filter);
  return keys.map((k) => k.slice(3));
}

/** A shared report the viewer may see: it names no custom field hidden from them (not even its key). */
async function viewable(d: ReportDefinition, user: AuthUser): Promise<boolean> {
  let def: ResourceDef;
  try {
    def = getRecordDef(d.entity);
  } catch {
    return false;
  }
  if (!can(user, `${def.resource}.view`)) return false;
  const keys = customKeys(d);
  if (!keys.length) return true;
  const fc = await filterContext(def, user);
  return keys.every((k) => fc.fieldLevels[k] !== 'hidden' && fc.customDefs.some((x) => x.key === k));
}

/** A saved report the user may open: their own, or shared, for a record type they may view. */
export async function visibleReport(uuid: string, user: AuthUser) {
  const row = await db('saved_reports')
    .where({ uuid })
    .where((w) => w.where({ owner_id: user.id }).orWhere({ shared: true }))
    .first();
  if (!row) throw notFound('Report');
  const definition = (
    typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition
  ) as ReportDefinition;
  if (row.owner_id !== user.id && !(await viewable(definition, user))) throw notFound('Report');
  return row as Record<string, unknown>;
}

const uuidParam = z.object({ uuid: z.uuid() });

export const reportBuilderRoutes = defineRoutes('/reports/custom', ['reports'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.reports.view',
    handler: async ({ user }) => {
      const rows = await db('saved_reports')
        .where((w) => w.where({ owner_id: user.id }).orWhere({ shared: true }))
        .orderBy('name');
      const out: SavedReportDto[] = [];
      for (const r of rows) {
        const dto = toDto(r, user);
        if (dto.mine || (await viewable(dto.definition, user))) out.push(dto);
      }
      return { data: out };
    },
  })
  .add({
    method: 'post',
    path: '/preview',
    permission: 'core.reports.view',
    body: reportDefinitionSchema,
    handler: ({ user, body }) => runReport(body, user),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.reports.view',
    body: savedReportInputSchema,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      if (body.shared) assertCan(user, 'core.saved_views.share');
      // Validates the definition against what this person can see.
      await runReport(body.definition, user);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('saved_reports').insert({
          uuid,
          name: body.name,
          entity: body.definition.entity,
          definition: JSON.stringify(body.definition),
          shared: body.shared,
          owner_id: user.id,
        });
        await audit(trx, ctx, {
          action: 'report.created',
          entity: 'saved_report',
          entityId: id,
          entityUuid: uuid,
          diff: body,
        });
      });
      return toDto(await db('saved_reports').where({ uuid }).first(), user);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.reports.view',
    params: uuidParam,
    body: toPatch(savedReportInputSchema),
    handler: async ({ ctx, user, params, body }) => {
      const row = await db('saved_reports').where({ uuid: params.uuid, owner_id: user.id }).first();
      if (!row) throw notFound('Report');
      // Changing a report everyone sees needs the right to share, like sharing it does.
      if (body.shared || row.shared) assertCan(user, 'core.saved_views.share');
      if (body.definition) await runReport(body.definition, user);
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.shared !== undefined) patch.shared = body.shared;
      if (body.definition)
        Object.assign(patch, { definition: JSON.stringify(body.definition), entity: body.definition.entity });
      await db.transaction(async (trx) => {
        await trx('saved_reports').where({ id: row.id }).update(patch);
        await audit(trx, ctx, {
          action: 'report.updated',
          entity: 'saved_report',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return toDto(await db('saved_reports').where({ id: row.id }).first(), user);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.reports.view',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await trx('saved_reports').where({ uuid: params.uuid, owner_id: user.id }).first('id');
        if (!row) throw notFound('Report');
        await trx('saved_reports').where({ id: row.id }).delete();
        await audit(trx, ctx, {
          action: 'report.deleted',
          entity: 'saved_report',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
    },
  })
  .add({
    method: 'get',
    path: '/:uuid/run',
    permission: 'core.reports.view',
    params: uuidParam,
    handler: async ({ user, params }) => {
      const row = await visibleReport(params.uuid, user);
      return runReport(
        typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition,
        user,
      );
    },
  });
