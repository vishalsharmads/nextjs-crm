import type { lineItemInput } from '@app/shared';
import { documentTotals, lineTotals, type DocumentTotals } from '@app/shared';
import type { Knex } from 'knex';
import type { z } from 'zod';
import { db, type Db } from '../../db/knex';
import type { AuthUser } from '../../http/context';
import { AppError } from '../../lib/errors';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';

/**
 * Building blocks shared by commercial modules (quotes, invoices, contracts):
 * gap-free numbering, scope-checked links to core records, and line items with server-computed totals.
 */

/** Take the next number for a sequence. Call inside the transaction that creates the document. */
export async function nextDocNumber(trx: Db, key: string): Promise<number> {
  await trx('doc_sequences').insert({ key, next_value: 1 }).onConflict('key').ignore();
  const row = await trx('doc_sequences').where({ key }).forUpdate().first('next_value');
  const n = Number(row.next_value);
  await trx('doc_sequences')
    .where({ key })
    .update({ next_value: n + 1 });
  return n;
}

export interface LinkInput {
  contactUuid?: string | null;
  organizationUuid?: string | null;
  dealUuid?: string | null;
}

const LINKS = [
  ['contactUuid', 'contact', 'contact_id'],
  ['organizationUuid', 'organization', 'organization_id'],
  ['dealUuid', 'deal', 'deal_id'],
] as const;

/**
 * Resolve linked core records to ids. A user can only link records they can see:
 * an out-of-scope record is reported as not found, exactly like a missing one.
 */
export async function resolveLinks(user: AuthUser, input: LinkInput, conn: Db = db) {
  const out: Partial<Record<'contact_id' | 'organization_id' | 'deal_id', number | null>> = {};
  for (const [key, entity, column] of LINKS) {
    const uuid = input[key];
    if (uuid === undefined) continue;
    if (uuid === null) {
      out[column] = null;
      continue;
    }
    try {
      out[column] = (await getRow(recordDefs[entity], user, uuid, conn)).id;
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'NOT_FOUND')) throw err;
      throw new AppError('VALIDATION_FAILED', 'Linked record not found', [
        { path: key, message: 'Not found' },
      ]);
    }
  }
  return out;
}

export interface RecordRef {
  uuid: string;
  name: string;
}

/** Names for linked records, batch-loaded per table. */
export async function linkRefs(rows: Record<string, unknown>[], conn: Db = db) {
  const load = async (table: string, column: string, nameCol: string) => {
    const ids = [...new Set(rows.map((r) => r[column]).filter((v): v is number => typeof v === 'number'))];
    if (!ids.length) return new Map<number, RecordRef>();
    const found = await conn(table).whereIn('id', ids).select('id', 'uuid', `${nameCol} as name`);
    return new Map(found.map((f) => [f.id as number, { uuid: f.uuid as string, name: f.name as string }]));
  };
  const [contacts, organizations, deals] = await Promise.all([
    load('contacts', 'contact_id', 'full_name'),
    load('organizations', 'organization_id', 'name'),
    load('deals', 'deal_id', 'title'),
  ]);
  return (r: Record<string, unknown>) => ({
    contact: contacts.get(r.contact_id as number) ?? null,
    organization: organizations.get(r.organization_id as number) ?? null,
    deal: deals.get(r.deal_id as number) ?? null,
  });
}

export type LineInput = z.output<typeof lineItemInput> & { productId: number | null };

/** Replace a document's lines and return its totals (computed here, never trusted from the client). */
export async function saveLines(
  trx: Db,
  table: string,
  fkColumn: string,
  docId: number,
  lines: LineInput[],
): Promise<DocumentTotals> {
  await trx(table).where(fkColumn, docId).delete();
  if (lines.length) {
    await trx(table).insert(
      lines.map((l, i) => {
        const t = lineTotals(l);
        return {
          [fkColumn]: docId,
          position: i,
          product_id: l.productId,
          name: l.name,
          description: l.description ?? null,
          quantity: l.quantity,
          unit_price: l.unitPrice,
          discount_pct: l.discountPct,
          tax_rate: l.taxRate,
          net: t.net,
          tax: t.tax,
          total: t.total,
        };
      }),
    );
  }
  return documentTotals(lines);
}

export interface LineDto {
  productUuid: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: number;
  net: number;
  tax: number;
  total: number;
}

/** Load lines for several documents, keyed by document id. */
export async function loadLines(
  table: string,
  fkColumn: string,
  docIds: number[],
  productTable: string | null,
  conn: Db = db,
): Promise<Map<number, LineDto[]>> {
  const out = new Map<number, LineDto[]>();
  if (!docIds.length) return out;
  const qb = conn(`${table} as l`)
    .whereIn(`l.${fkColumn}`, docIds)
    .orderBy([`l.${fkColumn}`, 'l.position']);
  if (productTable)
    qb.leftJoin(`${productTable} as p`, 'p.id', 'l.product_id').select('l.*', 'p.uuid as product_uuid');
  else qb.select('l.*');
  for (const r of await qb) {
    const list = out.get(r[fkColumn]) ?? [];
    list.push({
      productUuid: r.product_uuid ?? null,
      name: r.name,
      description: r.description,
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
      discountPct: Number(r.discount_pct),
      taxRate: Number(r.tax_rate),
      net: Number(r.net),
      tax: Number(r.tax),
      total: Number(r.total),
    });
    out.set(r[fkColumn], list);
  }
  return out;
}

/** Columns every commercial line-items table has (module migrations call this). */
export function lineItemColumns(t: Knex.CreateTableBuilder) {
  t.integer('position').unsigned().notNullable().defaultTo(0);
  t.bigInteger('product_id').unsigned().nullable();
  t.string('name', 200).notNullable();
  t.text('description').nullable();
  t.decimal('quantity', 14, 4).notNullable();
  t.decimal('unit_price', 15, 2).notNullable();
  t.decimal('discount_pct', 5, 2).notNullable().defaultTo(0);
  t.decimal('tax_rate', 6, 3).notNullable().defaultTo(0);
  t.decimal('net', 15, 2).notNullable();
  t.decimal('tax', 15, 2).notNullable();
  t.decimal('total', 15, 2).notNullable();
}

/** Columns every commercial document has: links, owner, money totals, timestamps. */
export function documentColumns(knex: Knex, t: Knex.CreateTableBuilder) {
  t.bigIncrements('id').unsigned().primary();
  t.specificType('uuid', 'CHAR(36)').notNullable().unique();
  t.string('number', 40).notNullable().unique();
  t.string('title', 200).notNullable().defaultTo('');
  t.bigInteger('contact_id').unsigned().nullable().references('id').inTable('contacts').onDelete('SET NULL');
  t.bigInteger('organization_id')
    .unsigned()
    .nullable()
    .references('id')
    .inTable('organizations')
    .onDelete('SET NULL');
  t.bigInteger('deal_id').unsigned().nullable().references('id').inTable('deals').onDelete('SET NULL');
  t.bigInteger('owner_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
  t.specificType('currency', 'CHAR(3)').notNullable();
  t.decimal('subtotal', 15, 2).notNullable().defaultTo(0);
  t.decimal('discount_total', 15, 2).notNullable().defaultTo(0);
  t.decimal('tax_total', 15, 2).notNullable().defaultTo(0);
  t.decimal('total', 15, 2).notNullable().defaultTo(0);
  t.text('notes').nullable();
  t.text('terms').nullable();
  t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
  t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  t.datetime('deleted_at').nullable();
  t.index(['owner_id']);
  t.index(['deal_id']);
  t.index(['organization_id']);
  t.index(['contact_id']);
}

export const totalsColumns = (t: DocumentTotals) => ({
  subtotal: t.subtotal,
  discount_total: t.discount,
  tax_total: t.tax,
  total: t.total,
});

/** Today's date (YYYY-MM-DD) in the workspace time zone, for issue and due dates. */
export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Add calendar months, clamping to the month's last day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
