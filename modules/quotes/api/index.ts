import { z } from 'zod';
import { documentTotals, formatDocNumber, lineItemInput, toPatch } from '@app/shared';
import {
  AppError,
  addDays,
  applyScope,
  assertCan,
  audit,
  db,
  defineRoutes,
  emit,
  escapeLike,
  every,
  getSettingsGroup,
  iso,
  linkRefs,
  loadLines,
  newUuid,
  nextDocNumber,
  notFound,
  notify,
  resolveLinks,
  saveLines,
  scopeAllows,
  systemContext,
  isModuleEnabled,
  todayIn,
  totalsColumns,
  userIdFromRef,
  userRefs,
  type ApiModule,
  type AuthUser,
  type Db,
  type Knex,
  type LineInput,
  type RequestContext,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_quotes';

const QUOTES = 'm_quotes_quotes';
const LINES = 'm_quotes_lines';
const PRODUCTS = 'm_products_products';
const RESOURCE = 'quotes.quotes';

const dateStr = z.iso.date();

const quoteBody = z.object({
  title: z.string().trim().max(200).default(''),
  contactUuid: z.uuid().nullish(),
  organizationUuid: z.uuid().nullish(),
  dealUuid: z.uuid().nullish(),
  ownerUuid: z.string().max(36).nullish(),
  currency: z.string().length(3).toUpperCase().optional(),
  issueDate: dateStr.optional(),
  validUntil: dateStr.nullish(),
  notes: z.string().max(5000).nullish(),
  terms: z.string().max(5000).nullish(),
  lines: z.array(lineItemInput).max(200).default([]),
});
type QuoteBody = z.output<typeof quoteBody>;

/** Map product uuids on lines to ids. Unknown products are a validation error. */
async function resolveProducts(lines: QuoteBody['lines'], conn: Db): Promise<LineInput[]> {
  const uuids = [...new Set(lines.map((l) => l.productUuid).filter((u): u is string => !!u))];
  const found = uuids.length ? await conn(PRODUCTS).whereIn('uuid', uuids).select('id', 'uuid') : [];
  const ids = new Map(found.map((p) => [p.uuid as string, p.id as number]));
  return lines.map((l, i) => {
    if (l.productUuid && !ids.has(l.productUuid))
      throw new AppError('VALIDATION_FAILED', 'Unknown product', [
        { path: `lines.${i}.productUuid`, message: 'Not found' },
      ]);
    return { ...l, productId: l.productUuid ? ids.get(l.productUuid)! : null };
  });
}

async function ownerFor(user: AuthUser, ref: string | null | undefined, conn: Db) {
  const id = await userIdFromRef(ref, user, conn);
  if (id === undefined || id === null) return id;
  if (id !== user.id && !(await scopeAllows(user, RESOURCE, [id], conn)))
    throw new AppError('FORBIDDEN', 'You can only assign quotes within your own access');
  return id;
}

async function toDtos(rows: Record<string, unknown>[], withLines: boolean) {
  const [refs, owners, lines] = await Promise.all([
    linkRefs(rows),
    userRefs(rows.map((r) => r.owner_id as number | null)),
    withLines
      ? loadLines(
          LINES,
          'quote_id',
          rows.map((r) => r.id as number),
          PRODUCTS,
        )
      : Promise.resolve(null),
  ]);
  return rows.map((r) => {
    const items = lines?.get(r.id as number) ?? [];
    return {
      uuid: r.uuid as string,
      number: r.number as string,
      title: r.title as string,
      status: r.status as string,
      issueDate: r.issue_date as string,
      validUntil: (r.valid_until as string | null) ?? null,
      currency: r.currency as string,
      ...refs(r),
      owner: owners.get(r.owner_id as number) ?? null,
      subtotal: Number(r.subtotal),
      discountTotal: Number(r.discount_total),
      taxTotal: Number(r.tax_total),
      total: Number(r.total),
      notes: (r.notes as string | null) ?? null,
      terms: (r.terms as string | null) ?? null,
      sentAt: iso(r.sent_at),
      respondedAt: iso(r.responded_at),
      acceptedByName: (r.accepted_by_name as string | null) ?? null,
      declineReason: (r.decline_reason as string | null) ?? null,
      convertedInvoiceUuid: (r.converted_invoice_uuid as string | null) ?? null,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      ...(withLines ? { lines: items, taxes: documentTotals(items).taxes } : {}),
    };
  });
}
export type QuoteDto = Awaited<ReturnType<typeof toDtos>>[number];

/** Load one quote the user may see; out of scope reads as not found. */
async function getScoped(user: AuthUser, uuid: string, conn: Db = db, forUpdate = false) {
  const qb = conn(QUOTES).where({ uuid }).whereNull('deleted_at');
  await applyScope(qb, user, RESOURCE, ['owner_id'], conn);
  if (forUpdate) qb.forUpdate();
  const row = await qb.first();
  if (!row) throw notFound('Quote');
  return row as Record<string, unknown> & { id: number; uuid: string; status: string };
}

async function getDto(uuid: string) {
  const row = await db(QUOTES).where({ uuid }).first();
  return (await toDtos([row], true))[0]!;
}

async function emitQuote(
  type: 'quote.created' | 'quote.sent' | 'quote.accepted' | 'quote.declined',
  uuid: string,
  actorId: number | null,
) {
  const record = await getDto(uuid);
  await emit({ type, entity: 'quote', uuid, record: record as unknown as Record<string, unknown>, actorId });
}

/** Status changes all follow the same shape: lock, check the allowed source states, update, audit. */
async function transition(
  ctx: RequestContext,
  user: AuthUser,
  uuid: string,
  from: string[],
  patch: (row: Record<string, unknown>) => Record<string, unknown>,
  action: string,
) {
  await db.transaction(async (trx) => {
    const row = await getScoped(user, uuid, trx, true);
    if (!from.includes(row.status))
      throw new AppError('CONFLICT', `This quote is ${row.status} and cannot be changed that way`);
    const next = patch(row);
    await trx(QUOTES)
      .where({ id: row.id })
      .update({ ...next, updated_at: new Date() });
    await audit(trx, ctx, {
      action: `quotes.quote.${action}`,
      entity: 'quotes.quote',
      entityId: row.id,
      entityUuid: uuid,
      diff: { status: { from: row.status, to: next.status ?? row.status } },
    });
  });
}

const uuidParam = z.object({ uuid: z.uuid() });

const routes = defineRoutes('/m/quotes/quotes', ['quotes'], 'quotes')
  .add({
    method: 'get',
    path: '/',
    permission: 'quotes.quotes.view',
    query: z.object({
      q: z.string().max(100).optional(),
      status: z.enum(['draft', 'sent', 'accepted', 'declined', 'expired']).optional(),
      dealUuid: z.uuid().optional(),
      organizationUuid: z.uuid().optional(),
      contactUuid: z.uuid().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
    handler: async ({ user, query }) => {
      const qb = db(QUOTES).whereNull('deleted_at');
      await applyScope(qb, user, RESOURCE, ['owner_id']);
      if (query.status) qb.where({ status: query.status });
      for (const [key, table, column] of [
        ['dealUuid', 'deals', 'deal_id'],
        ['organizationUuid', 'organizations', 'organization_id'],
        ['contactUuid', 'contacts', 'contact_id'],
      ] as const) {
        const uuid = query[key];
        if (uuid) qb.whereIn(column, db(table).where({ uuid }).select('id'));
      }
      if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        qb.where((w) => w.where('number', 'like', like).orWhere('title', 'like', like));
      }
      const total = Number(((await qb.clone().count({ c: '*' }).first()) as { c: number }).c);
      const rows = await qb
        .orderBy('id', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return {
        data: await toDtos(rows, false),
        meta: { page: query.page, pageSize: query.pageSize, total },
      };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'quotes.quotes.view',
    params: uuidParam,
    handler: async ({ user, params }) => (await toDtos([await getScoped(user, params.uuid)], true))[0],
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'quotes.quotes.create',
    body: quoteBody,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      const [general, commerce] = await Promise.all([
        getSettingsGroup('general'),
        getSettingsGroup('commerce'),
      ]);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const links = await resolveLinks(user, body, trx);
        const lines = await resolveProducts(body.lines, trx);
        const ownerId = (await ownerFor(user, body.ownerUuid, trx)) ?? user.id;
        const issueDate = body.issueDate ?? todayIn(general.timezone);
        const n = await nextDocNumber(trx, 'quote');
        const [id] = await trx(QUOTES).insert({
          uuid,
          number: formatDocNumber(commerce.quotePrefix, n),
          title: body.title,
          ...links,
          owner_id: ownerId,
          currency: body.currency ?? general.currency,
          status: 'draft',
          issue_date: issueDate,
          valid_until:
            body.validUntil === undefined ? addDays(issueDate, commerce.quoteValidityDays) : body.validUntil,
          notes: body.notes ?? null,
          terms: body.terms === undefined ? commerce.quoteTerms || null : body.terms,
          created_by: user.id,
        });
        const totals = await saveLines(trx, LINES, 'quote_id', id!, lines);
        await trx(QUOTES).where({ id }).update(totalsColumns(totals));
        await audit(trx, ctx, {
          action: 'quotes.quote.created',
          entity: 'quotes.quote',
          entityId: id,
          entityUuid: uuid,
          diff: { total: totals.total, lines: lines.length },
        });
      });
      await emitQuote('quote.created', uuid, user.id);
      return getDto(uuid);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'quotes.quotes.update',
    params: uuidParam,
    body: toPatch(quoteBody),
    summary: 'Only draft quotes can be edited. Revise a sent quote first.',
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'draft')
          throw new AppError('CONFLICT', 'Only draft quotes can be edited. Revise it to make changes.');
        const patch: Record<string, unknown> = { ...(await resolveLinks(user, body, trx)) };
        if (body.title !== undefined) patch.title = body.title;
        if (body.currency !== undefined) patch.currency = body.currency;
        if (body.issueDate !== undefined) patch.issue_date = body.issueDate;
        if (body.validUntil !== undefined) patch.valid_until = body.validUntil;
        if (body.notes !== undefined) patch.notes = body.notes;
        if (body.terms !== undefined) patch.terms = body.terms;
        const owner = await ownerFor(user, body.ownerUuid, trx);
        if (owner !== undefined) patch.owner_id = owner;
        if (body.lines !== undefined) {
          const totals = await saveLines(
            trx,
            LINES,
            'quote_id',
            row.id,
            await resolveProducts(body.lines, trx),
          );
          Object.assign(patch, totalsColumns(totals));
        }
        await trx(QUOTES)
          .where({ id: row.id })
          .update({ ...patch, updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'quotes.quote.updated',
          entity: 'quotes.quote',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { ...body, lines: body.lines ? body.lines.length : undefined },
        });
      });
      return getDto(params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/send',
    permission: 'quotes.quotes.update',
    params: uuidParam,
    summary: 'Mark a draft as sent to the customer.',
    handler: async ({ ctx, user, params }) => {
      const row = await getScoped(user, params.uuid);
      const count = Number(
        ((await db(LINES).where({ quote_id: row.id }).count({ c: '*' }).first()) as { c: number }).c,
      );
      if (!count) throw new AppError('VALIDATION_FAILED', 'Add at least one line before sending');
      await transition(
        ctx,
        user,
        params.uuid,
        ['draft'],
        () => ({ status: 'sent', sent_at: new Date() }),
        'sent',
      );
      await emitQuote('quote.sent', params.uuid, user.id);
      return getDto(params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/accept',
    permission: 'quotes.quotes.update',
    params: uuidParam,
    body: z.object({ acceptedByName: z.string().trim().max(200).nullish() }),
    summary: 'Record that the customer accepted (for example, signed on paper).',
    handler: async ({ ctx, user, params, body }) => {
      await transition(
        ctx,
        user,
        params.uuid,
        ['sent', 'expired'],
        () => ({
          status: 'accepted',
          responded_at: new Date(),
          accepted_by_name: body.acceptedByName ?? null,
        }),
        'accepted',
      );
      await emitQuote('quote.accepted', params.uuid, user.id);
      return getDto(params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/decline',
    permission: 'quotes.quotes.update',
    params: uuidParam,
    body: z.object({ reason: z.string().trim().max(500).nullish() }),
    handler: async ({ ctx, user, params, body }) => {
      await transition(
        ctx,
        user,
        params.uuid,
        ['sent', 'expired'],
        () => ({ status: 'declined', responded_at: new Date(), decline_reason: body.reason ?? null }),
        'declined',
      );
      await emitQuote('quote.declined', params.uuid, user.id);
      return getDto(params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/revise',
    permission: 'quotes.quotes.update',
    params: uuidParam,
    summary: 'Move a sent, declined or expired quote back to draft so it can be edited.',
    handler: async ({ ctx, user, params }) => {
      await transition(
        ctx,
        user,
        params.uuid,
        ['sent', 'declined', 'expired'],
        () => ({
          status: 'draft',
          sent_at: null,
          responded_at: null,
          decline_reason: null,
          accepted_by_name: null,
        }),
        'revised',
      );
      return getDto(params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/duplicate',
    permission: 'quotes.quotes.create',
    params: uuidParam,
    status: 201,
    handler: async ({ ctx, user, params }) => {
      const src = await getScoped(user, params.uuid);
      const lines = (await loadLines(LINES, 'quote_id', [src.id], PRODUCTS)).get(src.id) ?? [];
      const [general, commerce] = await Promise.all([
        getSettingsGroup('general'),
        getSettingsGroup('commerce'),
      ]);
      const issueDate = todayIn(general.timezone);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const n = await nextDocNumber(trx, 'quote');
        const [id] = await trx(QUOTES).insert({
          uuid,
          number: formatDocNumber(commerce.quotePrefix, n),
          title: src.title,
          contact_id: src.contact_id,
          organization_id: src.organization_id,
          deal_id: src.deal_id,
          owner_id: user.id,
          currency: src.currency,
          status: 'draft',
          issue_date: issueDate,
          valid_until: addDays(issueDate, commerce.quoteValidityDays),
          notes: src.notes,
          terms: src.terms,
          created_by: user.id,
        });
        const totals = await saveLines(trx, LINES, 'quote_id', id!, await resolveProducts(lines, trx));
        await trx(QUOTES).where({ id }).update(totalsColumns(totals));
        await audit(trx, ctx, {
          action: 'quotes.quote.created',
          entity: 'quotes.quote',
          entityId: id,
          entityUuid: uuid,
          diff: { duplicatedFrom: src.number },
        });
      });
      await emitQuote('quote.created', uuid, user.id);
      return getDto(uuid);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'quotes.quotes.delete',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status === 'accepted')
          throw new AppError('CONFLICT', 'Accepted quotes are kept for your records and cannot be deleted');
        await trx(QUOTES).where({ id: row.id }).update({ deleted_at: new Date() });
        await audit(trx, ctx, {
          action: 'quotes.quote.deleted',
          entity: 'quotes.quote',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
    },
  });

/** Read access for other modules (invoices converts accepted quotes, the portal shows them). */
export async function quoteForConversion(user: AuthUser, uuid: string, conn: Db = db) {
  assertCan(user, 'quotes.quotes.view');
  const row = await getScoped(user, uuid, conn, true);
  const lines = (await loadLines(LINES, 'quote_id', [row.id], PRODUCTS, conn)).get(row.id) ?? [];
  return { row, lines };
}

export async function markQuoteConverted(conn: Db, quoteId: number, invoiceUuid: string) {
  await conn(QUOTES)
    .where({ id: quoteId })
    .update({ converted_invoice_uuid: invoiceUuid, updated_at: new Date() });
}

/** Sent quotes past their validity date become expired (checked hourly). */
async function expireQuotes() {
  if (!isModuleEnabled('quotes')) return 0;
  const { timezone } = await getSettingsGroup('general');
  const today = todayIn(timezone);
  const due = await db(QUOTES)
    .where({ status: 'sent' })
    .whereNull('deleted_at')
    .whereNotNull('valid_until')
    .where('valid_until', '<', today)
    .limit(500)
    .select('id', 'uuid');
  for (const q of due) {
    await db.transaction(async (trx) => {
      const n = await trx(QUOTES)
        .where({ id: q.id, status: 'sent' })
        .update({ status: 'expired', updated_at: new Date() });
      if (n)
        await audit(trx, systemContext('job:quotes.expire'), {
          action: 'quotes.quote.expired',
          entity: 'quotes.quote',
          entityId: q.id,
          entityUuid: q.uuid,
        });
    });
  }
  return due.length;
}

export const quotes: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_quotes': m0001 },
  start: () => every(60 * 60_000, 'quotes.expire', expireQuotes),
};
export { expireQuotes };

/** Restricts a query to the documents one customer may see (built by the portal). */
export type CustomerMatch = (qb: Knex.QueryBuilder) => void;

/** Quotes a customer may see: never drafts. Detail (lines) only when one uuid is asked for. */
export async function customerQuotes(match: CustomerMatch, uuid?: string) {
  const qb = db(QUOTES).whereNull('deleted_at').whereNot({ status: 'draft' });
  match(qb);
  if (uuid) qb.where({ uuid });
  const rows = await qb.orderBy('id', 'desc').limit(uuid ? 1 : 100);
  return (await toDtos(rows, !!uuid)).map(
    ({ owner: _o, declineReason: _d, convertedInvoiceUuid: _c, notes, ...rest }) => ({ ...rest, notes }),
  );
}

/** The customer accepts or declines a sent quote from the portal. Expired quotes need a new one. */
export async function respondAsCustomer(
  ctx: RequestContext,
  match: CustomerMatch,
  uuid: string,
  response: { accept: true; name: string } | { accept: false; reason: string | null },
) {
  const { timezone } = await getSettingsGroup('general');
  const today = todayIn(timezone);
  await db.transaction(async (trx) => {
    const qb = trx(QUOTES).where({ uuid }).whereNull('deleted_at').forUpdate();
    match(qb);
    const row = await qb.first();
    if (!row) throw notFound('Quote');
    if (row.status !== 'sent' || (row.valid_until && row.valid_until < today))
      throw new AppError(
        'CONFLICT',
        'This quote can no longer be answered online. Contact us for a new one.',
      );
    const patch = response.accept
      ? { status: 'accepted', accepted_by_name: response.name }
      : { status: 'declined', decline_reason: response.reason };
    await trx(QUOTES)
      .where({ id: row.id })
      .update({ ...patch, responded_at: new Date(), updated_at: new Date() });
    await audit(trx, ctx, {
      action: `quotes.quote.${response.accept ? 'accepted' : 'declined'}`,
      entity: 'quotes.quote',
      entityId: row.id,
      entityUuid: uuid,
      diff: { via: 'portal', ...(response.accept ? { name: response.name } : { reason: response.reason }) },
    });
    if (row.owner_id)
      await notify(row.owner_id as number, {
        type: response.accept ? 'quote.accepted' : 'quote.declined',
        title: `${row.number} was ${response.accept ? 'accepted' : 'declined'} online`,
        body: response.accept ? `By ${response.name}` : (response.reason ?? null),
        link: `/m/quotes/${uuid}`,
        email: true,
      });
  });
  await emitQuote(response.accept ? 'quote.accepted' : 'quote.declined', uuid, null);
}
