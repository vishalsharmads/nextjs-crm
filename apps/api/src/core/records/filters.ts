import type { Knex } from 'knex';
import {
  FIELD_KEY_RE,
  isGroup,
  parseSort,
  type CustomFieldDef,
  type FilterCondition,
  type FilterNode,
  type VisibilityLevel,
} from '@app/shared';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import type { AuthUser } from '../../http/context';
import type { CoreFieldSpec, ResourceDef } from './types';

type Scalar = string | number | boolean;

const asArray = (v: unknown): Scalar[] =>
  Array.isArray(v) ? (v as Scalar[]) : v === undefined || v === null ? [] : [v as Scalar];

function invalid(message: string) {
  return new AppError('VALIDATION_FAILED', message, [{ path: 'filter', message }]);
}

/** Apply one operator to a column (or raw expression). Values are always bound parameters. */
export function applyOp(qb: Knex.QueryBuilder, col: string | Knex.Raw, cond: FilterCondition, kind: string) {
  const v = cond.value;
  const isDateKind = kind === 'date' || kind === 'datetime';
  switch (cond.op) {
    case 'eq':
      return v === null ? qb.whereNull(col as string) : qb.where(col as string, normalize(v, kind));
    case 'neq':
      return qb.where((w) => w.whereNot(col as string, normalize(v, kind)).orWhereNull(col as string));
    case 'in':
      return qb.whereIn(
        col as string,
        asArray(v).map((x) => normalize(x, kind)),
      );
    case 'nin':
      return qb.where((w) =>
        w
          .whereNotIn(
            col as string,
            asArray(v).map((x) => normalize(x, kind)),
          )
          .orWhereNull(col as string),
      );
    case 'contains':
      return qb.where(col as string, 'like', `%${escapeLike(String(v ?? ''))}%`);
    case 'starts_with':
      return qb.where(col as string, 'like', `${escapeLike(String(v ?? ''))}%`);
    case 'gt':
      return qb.where(col as string, '>', normalize(v, kind));
    case 'gte':
      return qb.where(col as string, '>=', normalize(v, kind));
    case 'lt':
      return qb.where(col as string, '<', normalize(v, kind));
    case 'lte':
      return qb.where(col as string, '<=', normalize(v, kind));
    case 'between': {
      const [a, b] = asArray(v);
      if (a === undefined || b === undefined) throw invalid('between needs two values');
      return qb.whereBetween(col as string, [normalize(a, kind), normalize(b, kind)]);
    }
    case 'is_empty':
      return qb.where((w) => {
        w.whereNull(col as string);
        if (kind === 'text' || kind === 'select') w.orWhere(col as string, '');
      });
    case 'is_not_empty':
      return qb.where((w) => {
        w.whereNotNull(col as string);
        if (kind === 'text' || kind === 'select') w.where(col as string, '<>', '');
      });
    case 'within_last_days':
    case 'within_next_days': {
      if (!isDateKind) throw invalid(`${cond.op} only works on dates`);
      const days = Number(v);
      if (!Number.isInteger(days) || days < 0 || days > 3650) throw invalid('Days must be a whole number');
      const now = new Date();
      const other = new Date(now.getTime() + (cond.op === 'within_next_days' ? 1 : -1) * days * 86_400_000);
      const [from, to] = cond.op === 'within_next_days' ? [now, other] : [other, now];
      return qb.whereBetween(col as string, [fmtDate(from, kind), fmtDate(to, kind)]);
    }
    case 'today': {
      if (!isDateKind) throw invalid('today only works on dates');
      const d = new Date();
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const end = new Date(start.getTime() + 86_400_000 - 1);
      return qb.whereBetween(col as string, [fmtDate(start, kind), fmtDate(end, kind)]);
    }
  }
}

function fmtDate(d: Date, kind: string) {
  if (kind === 'date') return d.toISOString().slice(0, 10);
  return kind === 'datetime-text' ? d.toISOString() : d;
}

function normalize(v: unknown, kind: string): Scalar {
  if (kind === 'boolean') return v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0;
  if (kind === 'number') return Number(v);
  return v as Scalar;
}

export function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface FilterContext {
  def: ResourceDef;
  user: AuthUser;
  customDefs: CustomFieldDef[];
  fieldLevels: Record<string, VisibilityLevel>;
}

/** Resolve a custom field key to its definition, enforcing visibility and filterability. */
function customField(key: string, fc: FilterContext, purpose: 'filter' | 'sort'): CustomFieldDef {
  if (!FIELD_KEY_RE.test(key)) throw invalid(`Unknown field cf.${key}`);
  const def = fc.customDefs.find((d) => d.key === key);
  if (!def) throw invalid(`Unknown field cf.${key}`);
  if (fc.fieldLevels[key] === 'hidden')
    throw new AppError('FIELD_FORBIDDEN', `You cannot ${purpose} by ${def.label}`);
  if (!def.filterable) throw invalid(`${def.label} is not set up for filtering and sorting`);
  return def;
}

function customColumn(table: string, def: CustomFieldDef) {
  return `${table}.cf_${def.key}`;
}

function compileCondition(qb: Knex.QueryBuilder, cond: FilterCondition, fc: FilterContext) {
  const { def: res, user } = fc;
  if (cond.field.startsWith('cf.')) {
    const def = customField(cond.field.slice(3), fc, 'filter');
    if (def.type === 'multi_select') {
      const values = asArray(cond.value).map(String);
      const path = `$.${def.key}`;
      switch (cond.op) {
        case 'in':
        case 'eq':
          return qb.whereRaw(`JSON_OVERLAPS(??->?, CAST(? AS JSON))`, [
            `${res.table}.custom`,
            path,
            JSON.stringify(values),
          ]);
        case 'nin':
        case 'neq':
          return qb.whereRaw(`NOT COALESCE(JSON_OVERLAPS(??->?, CAST(? AS JSON)), FALSE)`, [
            `${res.table}.custom`,
            path,
            JSON.stringify(values),
          ]);
        case 'is_empty':
          return qb.whereRaw(`COALESCE(JSON_LENGTH(??->?), 0) = 0`, [`${res.table}.custom`, path]);
        case 'is_not_empty':
          return qb.whereRaw(`JSON_LENGTH(??->?) > 0`, [`${res.table}.custom`, path]);
        default:
          throw invalid(`${cond.op} is not supported for ${def.label}`);
      }
    }
    if (def.type === 'user') {
      const value = asArray(cond.value).map((v) => (v === '@me' ? user.uuid : v));
      return applyOp(
        qb,
        customColumn(res.table, def),
        { ...cond, value: cond.op === 'eq' || cond.op === 'neq' ? value[0] : value },
        'text',
      );
    }
    const kind =
      def.type === 'number' || def.type === 'decimal' || def.type === 'currency'
        ? 'number'
        : def.type === 'datetime'
          ? 'datetime-text'
          : def.type === 'date'
            ? 'date'
            : def.type === 'boolean'
              ? 'boolean'
              : 'text';
    return applyOp(qb, customColumn(res.table, def), cond, kind);
  }
  const spec: CoreFieldSpec | undefined = res.fields[cond.field];
  if (!spec || spec.filterable === false) throw invalid(`Cannot filter by ${cond.field}`);
  if (spec.filter) return spec.filter(qb, cond, user);
  if (!spec.column) throw invalid(`Cannot filter by ${cond.field}`);
  return applyOp(qb, spec.column, cond, spec.kind);
}

export function compileFilter(qb: Knex.QueryBuilder, node: FilterNode, fc: FilterContext) {
  if (isGroup(node)) {
    const isAnd = 'and' in node;
    const children = isAnd ? node.and : node.or;
    if (!children.length) return qb;
    return qb.where((w) => {
      for (const child of children) {
        if (isAnd) w.andWhere((c) => compileFilter(c, child, fc));
        else w.orWhere((c) => compileFilter(c, child, fc));
      }
    });
  }
  return compileCondition(qb, node, fc);
}

export function applySort(qb: Knex.QueryBuilder, sort: string | undefined, fc: FilterContext) {
  const specs = parseSort(sort ?? fc.def.defaultSort);
  for (const s of specs) {
    if (s.field.startsWith('cf.')) {
      const def = customField(s.field.slice(3), fc, 'sort');
      if (def.type === 'multi_select') throw invalid(`Cannot sort by ${def.label}`);
      qb.orderByRaw(`?? IS NULL, ?? ${s.dir}`, [
        customColumn(fc.def.table, def),
        customColumn(fc.def.table, def),
      ]);
      continue;
    }
    const spec = fc.def.fields[s.field];
    if (!spec || !spec.sortable) throw invalid(`Cannot sort by ${s.field}`);
    if (spec.sortExpr) qb.orderByRaw(`${spec.sortExpr} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
    else qb.orderBy(spec.column!, s.dir);
  }
  qb.orderBy(`${fc.def.table}.id`, 'desc');
  return qb;
}

/** Turn free text into a safe MySQL boolean-mode query: every word required, prefix-matched. */
export function fulltextQuery(q: string): string | null {
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  if (!words.length) return null;
  return words.map((w) => `+${w}*`).join(' ');
}

export function applySearch(qb: Knex.QueryBuilder, q: string | undefined, def: ResourceDef) {
  const term = q?.trim();
  if (!term) return qb;
  const ft = fulltextQuery(term);
  return qb.where((w) => {
    if (ft && def.fulltext.length) {
      w.whereRaw(`MATCH(${def.fulltext.map(() => '??').join(', ')}) AGAINST (? IN BOOLEAN MODE)`, [
        ...def.fulltext,
        ft,
      ]);
    }
    for (const col of def.likeColumns) w.orWhere(col, 'like', `${escapeLike(term)}%`);
  });
}

/** Subquery of user ids for uuids ('@me' allowed). */
export function userIdSubquery(values: unknown, user: AuthUser) {
  const uuids = asArray(values).map((v) => (v === '@me' ? user.uuid : String(v)));
  return db('users')
    .select('id')
    .whereIn('uuid', uuids.length ? uuids : ['']);
}
