import { normalizePhone } from '@app/shared';
import { db } from '../../db/knex';
import { getDefinitions, fieldAccessMap } from '../custom-fields/definitions';
import type { AuthUser } from '../../http/context';
import type { CoreEntity } from '@app/shared';
import { applyOp, userIdSubquery } from './filters';
import type { CoreFieldSpec } from './types';

export const ownerField = (table: string, column = 'owner_id'): CoreFieldSpec => ({
  kind: 'user',
  sortable: true,
  sortExpr: `(SELECT CONCAT(u.first_name, ' ', u.last_name) FROM users u WHERE u.id = ${table}.${column})`,
  filter: (qb, cond, user) => {
    const col = `${table}.${column}`;
    if (cond.op === 'is_empty') return void qb.whereNull(col);
    if (cond.op === 'is_not_empty') return void qb.whereNotNull(col);
    const sub = userIdSubquery(cond.value, user);
    if (cond.op === 'neq' || cond.op === 'nin') qb.where((w) => w.whereNotIn(col, sub).orWhereNull(col));
    else qb.whereIn(col, sub);
  },
});

export const textField = (column: string, sortable = true): CoreFieldSpec => ({
  kind: 'text',
  column,
  sortable,
  filterable: true,
});
export const selectField = (column: string): CoreFieldSpec => ({
  kind: 'select',
  column,
  sortable: true,
  filterable: true,
});
export const dateField = (column: string, kind: 'date' | 'datetime' = 'datetime'): CoreFieldSpec => ({
  kind,
  column,
  sortable: true,
  filterable: true,
});
export const numberField = (column: string): CoreFieldSpec => ({
  kind: 'number',
  column,
  sortable: true,
  filterable: true,
});

export function timestampsFields(table: string): Record<string, CoreFieldSpec> {
  return { created_at: dateField(`${table}.created_at`), updated_at: dateField(`${table}.updated_at`) };
}

/** Relation filter by related record uuid via a column (e.g. deals.contact_id → contacts.uuid). */
export const relationField = (
  table: string,
  column: string,
  related: string,
  sortColumn: string,
): CoreFieldSpec => ({
  kind: 'relation',
  sortable: true,
  sortExpr: `(SELECT r.${sortColumn} FROM ${related} r WHERE r.id = ${table}.${column})`,
  filter: (qb, cond) => {
    const col = `${table}.${column}`;
    if (cond.op === 'is_empty') return void qb.whereNull(col);
    if (cond.op === 'is_not_empty') return void qb.whereNotNull(col);
    const values = (Array.isArray(cond.value) ? cond.value : [cond.value]).map(String);
    const sub = db(related)
      .select('id')
      .whereIn('uuid', values.length ? values : ['']);
    if (cond.op === 'neq' || cond.op === 'nin') qb.where((w) => w.whereNotIn(col, sub).orWhereNull(col));
    else qb.whereIn(col, sub);
  },
});

export const phoneE164 = (phone: string | null | undefined) =>
  phone ? normalizePhone(phone) || null : phone === null ? null : undefined;

export async function customContext(entity: CoreEntity, user: AuthUser) {
  const defs = await getDefinitions(entity);
  return { defs, levels: fieldAccessMap(defs, user) };
}

export { applyOp };

/** Drop undefined keys so a patch only touches what was sent. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
