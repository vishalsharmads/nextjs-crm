import { z } from 'zod';
import {
  PAYMENT_METHODS,
  addMoney,
  documentTotals,
  formatDocNumber,
  lineItemInput,
  subtractMoney,
  toPatch,
} from '@app/shared';
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
  isModuleEnabled,
  iso,
  linkRefs,
  loadLines,
  newUuid,
  nextDocNumber,
  notFound,
  notify,
  registerModuleWidget,
  resolveLinks,
  saveLines,
  scopeAllows,
  systemContext,
  todayIn,
  totalsColumns,
  userIdFromRef,
  userRefs,
  type ApiModule,
  type AuthUser,
  type Db,
  type LineInput,
  type RequestContext,
} from '@app/api/module-api';
import { markQuoteConverted, quoteForConversion } from '../../quotes/api';
import * as m0001 from './migrations/0001_invoices';

const INVOICES = 'm_invoices_invoices';
const LINES = 'm_invoices_lines';
const PAYMENTS = 'm_invoices_payments';
const PRODUCTS = 'm_products_products';
const RESOURCE = 'invoices.invoices';
const OPEN = ['issued', 'partially_paid'];

const dateStr = z.iso.date();

const invoiceBody = z.object({
  title: z.string().trim().max(200).default(''),
  contactUuid: z.uuid().nullish(),
  organizationUuid: z.uuid().nullish(),
  dealUuid: z.uuid().nullish(),
  ownerUuid: z.string().max(36).nullish(),
  currency: z.string().length(3).toUpperCase().optional(),
  issueDate: dateStr.optional(),
  dueDate: dateStr.nullish(),
  notes: z.string().max(5000).nullish(),
  terms: z.string().max(5000).nullish(),
  paymentInstructions: z.string().max(2000).nullish(),
  lines: z.array(lineItemInput).max(200).default([]),
});
type InvoiceBody = z.output<typeof invoiceBody>;

const paymentBody = z.object({
  amount: z.coerce.number().positive().max(100_000_000),
  paidOn: dateStr.optional(),
  method: z.enum(PAYMENT_METHODS).default('bank_transfer'),
  reference: z.string().trim().max(200).nullish(),
  note: z.string().trim().max(1000).nullish(),
});

async function resolveProducts(lines: InvoiceBody['lines'], conn: Db): Promise<LineInput[]> {
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
    throw new AppError('FORBIDDEN', 'You can only assign invoices within your own access');
  return id;
}

async function toDtos(rows: Record<string, unknown>[], withDetail: boolean, today: string) {
  const ids = rows.map((r) => r.id as number);
  const [refs, owners, lines, payments] = await Promise.all([
    linkRefs(rows),
    userRefs(rows.map((r) => r.owner_id as number | null)),
    withDetail ? loadLines(LINES, 'invoice_id', ids, PRODUCTS) : Promise.resolve(null),
    withDetail && ids.length
      ? db(PAYMENTS).whereIn('invoice_id', ids).orderBy(['paid_on', 'id'])
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  return rows.map((r) => {
    const total = Number(r.total);
    const paid = Number(r.amount_paid);
    const status = r.status as string;
    const items = lines?.get(r.id as number) ?? [];
    return {
      uuid: r.uuid as string,
      number: r.number as string,
      title: r.title as string,
      status,
      overdue: OPEN.includes(status) && !!r.due_date && (r.due_date as string) < today,
      issueDate: r.issue_date as string,
      dueDate: (r.due_date as string | null) ?? null,
      currency: r.currency as string,
      ...refs(r),
      owner: owners.get(r.owner_id as number) ?? null,
      subtotal: Number(r.subtotal),
      discountTotal: Number(r.discount_total),
      taxTotal: Number(r.tax_total),
      total,
      amountPaid: paid,
      balanceDue: status === 'void' ? 0 : subtractMoney(total, paid),
      notes: (r.notes as string | null) ?? null,
      terms: (r.terms as string | null) ?? null,
      paymentInstructions: (r.payment_instructions as string | null) ?? null,
      issuedAt: iso(r.issued_at),
      paidAt: iso(r.paid_at),
      voidedAt: iso(r.voided_at),
      voidReason: (r.void_reason as string | null) ?? null,
      sourceQuoteUuid: (r.source_quote_uuid as string | null) ?? null,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      ...(withDetail
        ? {
            lines: items,
            taxes: documentTotals(items).taxes,
            payments: payments
              .filter((p) => p.invoice_id === r.id)
              .map((p) => ({
                uuid: p.uuid as string,
                amount: Number(p.amount),
                paidOn: p.paid_on as string,
                method: p.method as string,
                reference: (p.reference as string | null) ?? null,
                note: (p.note as string | null) ?? null,
                createdAt: iso(p.created_at)!,
              })),
          }
        : {}),
    };
  });
}

async function today() {
  return todayIn((await getSettingsGroup('general')).timezone);
}

async function getScoped(user: AuthUser, uuid: string, conn: Db = db, forUpdate = false) {
  const qb = conn(INVOICES).where({ uuid }).whereNull('deleted_at');
  await applyScope(qb, user, RESOURCE, ['owner_id'], conn);
  if (forUpdate) qb.forUpdate();
  const row = await qb.first();
  if (!row) throw notFound('Invoice');
  return row as Record<string, unknown> & { id: number; uuid: string; status: string };
}

async function getDto(uuid: string) {
  const row = await db(INVOICES).where({ uuid }).first();
  return (await toDtos([row], true, await today()))[0]!;
}

type InvoiceEvent =
  'invoice.created' | 'invoice.issued' | 'invoice.paid' | 'invoice.voided' | 'invoice.overdue';
async function emitInvoice(type: InvoiceEvent, uuid: string, actorId: number | null) {
  const record = await getDto(uuid);
  await emit({
    type,
    entity: 'invoice',
    uuid,
    record: record as unknown as Record<string, unknown>,
    actorId,
  });
}

/** Insert an invoice with its lines inside a transaction; returns its id. */
async function insertInvoice(
  trx: Db,
  ctx: RequestContext,
  user: AuthUser,
  uuid: string,
  data: Record<string, unknown>,
  lines: LineInput[],
  auditDiff: Record<string, unknown>,
) {
  const commerce = await getSettingsGroup('commerce', trx);
  const n = await nextDocNumber(trx, 'invoice');
  const [id] = await trx(INVOICES).insert({
    uuid,
    number: formatDocNumber(commerce.invoicePrefix, n),
    status: 'draft',
    created_by: user.id,
    ...data,
  });
  const totals = await saveLines(trx, LINES, 'invoice_id', id!, lines);
  await trx(INVOICES).where({ id }).update(totalsColumns(totals));
  await audit(trx, ctx, {
    action: 'invoices.invoice.created',
    entity: 'invoices.invoice',
    entityId: id,
    entityUuid: uuid,
    diff: { total: totals.total, lines: lines.length, ...auditDiff },
  });
  return id!;
}

/** Status after a payment change: paid in full, partly paid, or back to issued. */
function paymentStatus(total: number, paid: number) {
  if (paid > 0 && subtractMoney(total, paid) <= 0) return 'paid';
  if (paid > 0) return 'partially_paid';
  return 'issued';
}

const uuidParam = z.object({ uuid: z.uuid() });

const routes = defineRoutes('/m/invoices/invoices', ['invoices'], 'invoices')
  .add({
    method: 'get',
    path: '/',
    permission: 'invoices.invoices.view',
    query: z.object({
      q: z.string().max(100).optional(),
      status: z.enum(['draft', 'issued', 'partially_paid', 'paid', 'void', 'open', 'overdue']).optional(),
      dealUuid: z.uuid().optional(),
      organizationUuid: z.uuid().optional(),
      contactUuid: z.uuid().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
    handler: async ({ user, query }) => {
      const now = await today();
      const qb = db(INVOICES).whereNull('deleted_at');
      await applyScope(qb, user, RESOURCE, ['owner_id']);
      if (query.status === 'open') qb.whereIn('status', OPEN);
      else if (query.status === 'overdue') qb.whereIn('status', OPEN).where('due_date', '<', now);
      else if (query.status) qb.where({ status: query.status });
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
        data: await toDtos(rows, false, now),
        meta: { page: query.page, pageSize: query.pageSize, total },
      };
    },
  })
  .add({
    method: 'post',
    path: '/from-quote/:quoteUuid',
    permission: 'invoices.invoices.create',
    params: z.object({ quoteUuid: z.uuid() }),
    status: 201,
    summary: 'Create a draft invoice from an accepted quote (once per quote).',
    handler: async ({ ctx, user, params }) => {
      if (!isModuleEnabled('quotes')) throw new AppError('MODULE_DISABLED', 'Quotes are turned off');
      const [general, commerce] = await Promise.all([
        getSettingsGroup('general'),
        getSettingsGroup('commerce'),
      ]);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const { row: q, lines } = await quoteForConversion(user, params.quoteUuid, trx);
        if (q.status !== 'accepted') throw new AppError('CONFLICT', 'Only accepted quotes can be invoiced');
        if (q.converted_invoice_uuid) throw new AppError('CONFLICT', 'This quote already has an invoice');
        const issueDate = todayIn(general.timezone);
        await insertInvoice(
          trx,
          ctx,
          user,
          uuid,
          {
            title: q.title,
            contact_id: q.contact_id,
            organization_id: q.organization_id,
            deal_id: q.deal_id,
            owner_id: user.id,
            currency: q.currency,
            issue_date: issueDate,
            due_date: addDays(issueDate, commerce.invoiceDueDays),
            notes: q.notes,
            terms: commerce.invoiceTerms || null,
            payment_instructions: commerce.paymentInstructions || null,
            source_quote_uuid: q.uuid,
          },
          await resolveProducts(lines, trx),
          { fromQuote: q.number },
        );
        await markQuoteConverted(trx, q.id, uuid);
      });
      await emitInvoice('invoice.created', uuid, user.id);
      return getDto(uuid);
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'invoices.invoices.view',
    params: uuidParam,
    handler: async ({ user, params }) =>
      (await toDtos([await getScoped(user, params.uuid)], true, await today()))[0],
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'invoices.invoices.create',
    body: invoiceBody,
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
        await insertInvoice(
          trx,
          ctx,
          user,
          uuid,
          {
            title: body.title,
            ...links,
            owner_id: ownerId,
            currency: body.currency ?? general.currency,
            issue_date: issueDate,
            due_date: body.dueDate === undefined ? addDays(issueDate, commerce.invoiceDueDays) : body.dueDate,
            notes: body.notes ?? null,
            terms: body.terms === undefined ? commerce.invoiceTerms || null : body.terms,
            payment_instructions:
              body.paymentInstructions === undefined
                ? commerce.paymentInstructions || null
                : body.paymentInstructions,
          },
          lines,
          {},
        );
      });
      await emitInvoice('invoice.created', uuid, user.id);
      return getDto(uuid);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'invoices.invoices.update',
    params: uuidParam,
    body: toPatch(invoiceBody),
    summary: 'Only draft invoices can be edited. Issued invoices are a record of what was billed.',
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'draft')
          throw new AppError(
            'CONFLICT',
            'Only draft invoices can be edited. Void it and issue a new one instead.',
          );
        const patch: Record<string, unknown> = { ...(await resolveLinks(user, body, trx)) };
        if (body.title !== undefined) patch.title = body.title;
        if (body.currency !== undefined) patch.currency = body.currency;
        if (body.issueDate !== undefined) patch.issue_date = body.issueDate;
        if (body.dueDate !== undefined) patch.due_date = body.dueDate;
        if (body.notes !== undefined) patch.notes = body.notes;
        if (body.terms !== undefined) patch.terms = body.terms;
        if (body.paymentInstructions !== undefined) patch.payment_instructions = body.paymentInstructions;
        const owner = await ownerFor(user, body.ownerUuid, trx);
        if (owner !== undefined) patch.owner_id = owner;
        if (body.lines !== undefined) {
          const totals = await saveLines(
            trx,
            LINES,
            'invoice_id',
            row.id,
            await resolveProducts(body.lines, trx),
          );
          Object.assign(patch, totalsColumns(totals));
        }
        await trx(INVOICES)
          .where({ id: row.id })
          .update({ ...patch, updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'invoices.invoice.updated',
          entity: 'invoices.invoice',
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
    path: '/:uuid/issue',
    permission: 'invoices.invoices.update',
    params: uuidParam,
    summary: 'Finalize a draft. Its lines and totals are locked from then on.',
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'draft') throw new AppError('CONFLICT', 'Only draft invoices can be issued');
        const count = Number(
          ((await trx(LINES).where({ invoice_id: row.id }).count({ c: '*' }).first()) as { c: number }).c,
        );
        if (!count) throw new AppError('VALIDATION_FAILED', 'Add at least one line before issuing');
        if (Number(row.total) <= 0)
          throw new AppError('VALIDATION_FAILED', 'The total must be more than zero');
        await trx(INVOICES)
          .where({ id: row.id })
          .update({ status: 'issued', issued_at: new Date(), updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'invoices.invoice.issued',
          entity: 'invoices.invoice',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { total: Number(row.total) },
        });
      });
      await emitInvoice('invoice.issued', params.uuid, user.id);
      return getDto(params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/void',
    permission: 'invoices.invoices.update',
    params: uuidParam,
    body: z.object({ reason: z.string().trim().min(1).max(500) }),
    summary: 'Cancel an issued invoice. It stays on record with its number. Remove payments first.',
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (!OPEN.includes(row.status))
          throw new AppError('CONFLICT', `A ${row.status} invoice cannot be voided`);
        if (Number(row.amount_paid) > 0)
          throw new AppError('CONFLICT', 'This invoice has payments. Remove them before voiding it.');
        await trx(INVOICES).where({ id: row.id }).update({
          status: 'void',
          voided_at: new Date(),
          void_reason: body.reason,
          updated_at: new Date(),
        });
        await audit(trx, ctx, {
          action: 'invoices.invoice.voided',
          entity: 'invoices.invoice',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { reason: body.reason },
        });
      });
      await emitInvoice('invoice.voided', params.uuid, user.id);
      return getDto(params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/duplicate',
    permission: 'invoices.invoices.create',
    params: uuidParam,
    status: 201,
    handler: async ({ ctx, user, params }) => {
      const src = await getScoped(user, params.uuid);
      const lines = (await loadLines(LINES, 'invoice_id', [src.id], PRODUCTS)).get(src.id) ?? [];
      const [general, commerce] = await Promise.all([
        getSettingsGroup('general'),
        getSettingsGroup('commerce'),
      ]);
      const issueDate = todayIn(general.timezone);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        await insertInvoice(
          trx,
          ctx,
          user,
          uuid,
          {
            title: src.title,
            contact_id: src.contact_id,
            organization_id: src.organization_id,
            deal_id: src.deal_id,
            owner_id: user.id,
            currency: src.currency,
            issue_date: issueDate,
            due_date: addDays(issueDate, commerce.invoiceDueDays),
            notes: src.notes,
            terms: src.terms,
            payment_instructions: src.payment_instructions,
          },
          await resolveProducts(lines, trx),
          { duplicatedFrom: src.number },
        );
      });
      await emitInvoice('invoice.created', uuid, user.id);
      return getDto(uuid);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'invoices.invoices.delete',
    params: uuidParam,
    summary: 'Only drafts can be deleted. Issued invoices are voided instead, so numbering has no gaps.',
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'draft')
          throw new AppError('CONFLICT', 'Issued invoices cannot be deleted. Void it instead.');
        await trx(INVOICES).where({ id: row.id }).update({ deleted_at: new Date() });
        await audit(trx, ctx, {
          action: 'invoices.invoice.deleted',
          entity: 'invoices.invoice',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/payments',
    permission: 'invoices.payments.manage',
    params: uuidParam,
    body: paymentBody,
    status: 201,
    handler: async ({ ctx, user, params, body }) => {
      const paidOn = body.paidOn ?? (await today());
      let status = '';
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (!OPEN.includes(row.status))
          throw new AppError('CONFLICT', 'Payments can only be recorded on issued, unpaid invoices');
        const balance = subtractMoney(Number(row.total), Number(row.amount_paid));
        if (body.amount > balance)
          throw new AppError('VALIDATION_FAILED', 'The payment is more than the balance due', [
            { path: 'amount', message: `At most ${balance.toFixed(2)}` },
          ]);
        const uuid = newUuid();
        const [id] = await trx(PAYMENTS).insert({
          uuid,
          invoice_id: row.id,
          amount: body.amount,
          paid_on: paidOn,
          method: body.method,
          reference: body.reference ?? null,
          note: body.note ?? null,
          created_by: user.id,
        });
        const paid = addMoney(Number(row.amount_paid), body.amount);
        status = paymentStatus(Number(row.total), paid);
        await trx(INVOICES)
          .where({ id: row.id })
          .update({
            amount_paid: paid,
            status,
            paid_at: status === 'paid' ? new Date() : null,
            updated_at: new Date(),
          });
        await audit(trx, ctx, {
          action: 'invoices.payment.recorded',
          entity: 'invoices.payment',
          entityId: id,
          entityUuid: uuid,
          diff: { invoice: row.number, amount: body.amount, method: body.method },
        });
      });
      const invoice = await getDto(params.uuid);
      await emit({
        type: 'payment.recorded',
        entity: 'payment',
        uuid: params.uuid,
        record: { amount: body.amount, paidOn, method: body.method, invoice } as unknown as Record<
          string,
          unknown
        >,
        actorId: user.id,
      });
      if (status === 'paid') await emitInvoice('invoice.paid', params.uuid, user.id);
      return invoice;
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid/payments/:paymentUuid',
    permission: 'invoices.payments.manage',
    params: z.object({ uuid: z.uuid(), paymentUuid: z.uuid() }),
    summary: 'Remove a payment recorded by mistake. The invoice balance and status are recalculated.',
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        const payment = await trx(PAYMENTS).where({ uuid: params.paymentUuid, invoice_id: row.id }).first();
        if (!payment) throw notFound('Payment');
        await trx(PAYMENTS).where({ id: payment.id }).delete();
        const paid = subtractMoney(Number(row.amount_paid), Number(payment.amount));
        await trx(INVOICES)
          .where({ id: row.id })
          .update({
            amount_paid: paid,
            status: paymentStatus(Number(row.total), paid),
            paid_at: null,
            updated_at: new Date(),
          });
        await audit(trx, ctx, {
          action: 'invoices.payment.removed',
          entity: 'invoices.payment',
          entityId: payment.id,
          entityUuid: params.paymentUuid,
          diff: { invoice: row.number, amount: Number(payment.amount) },
        });
      });
    },
  });

/** Open invoices past their due date: emit `invoice.overdue` once and tell the owner. */
export async function flagOverdueInvoices() {
  if (!isModuleEnabled('invoices')) return 0;
  const now = await today();
  const due = await db(INVOICES)
    .whereIn('status', OPEN)
    .whereNull('deleted_at')
    .whereNull('overdue_notified_at')
    .whereNotNull('due_date')
    .where('due_date', '<', now)
    .limit(500)
    .select('id', 'uuid', 'number', 'owner_id');
  for (const inv of due) {
    const n = await db.transaction(async (trx) => {
      const updated = await trx(INVOICES)
        .where({ id: inv.id })
        .whereNull('overdue_notified_at')
        .update({ overdue_notified_at: new Date() });
      if (updated)
        await audit(trx, systemContext('job:invoices.overdue'), {
          action: 'invoices.invoice.overdue',
          entity: 'invoices.invoice',
          entityId: inv.id,
          entityUuid: inv.uuid,
        });
      return updated;
    });
    if (!n) continue;
    if (inv.owner_id)
      await notify(inv.owner_id as number, {
        type: 'invoice.overdue',
        title: `Invoice ${inv.number} is overdue`,
        body: null,
        link: `/m/invoices/${inv.uuid}`,
        email: true,
      });
    await emitInvoice('invoice.overdue', inv.uuid as string, null);
  }
  return due.length;
}

registerModuleWidget('invoices.receivables', async (_params, user) => {
  assertCan(user, 'invoices.invoices.view');
  const now = await today();
  const qb = db(INVOICES).whereNull('deleted_at').whereIn('status', OPEN);
  await applyScope(qb, user, RESOURCE, ['owner_id']);
  const rows = await qb.select('currency', 'total', 'amount_paid', 'due_date');
  const byCurrency = new Map<
    string,
    { outstanding: number; overdue: number; count: number; overdueCount: number }
  >();
  for (const r of rows) {
    const c = byCurrency.get(r.currency) ?? { outstanding: 0, overdue: 0, count: 0, overdueCount: 0 };
    const balance = subtractMoney(Number(r.total), Number(r.amount_paid));
    c.outstanding = addMoney(c.outstanding, balance);
    c.count += 1;
    if (r.due_date && r.due_date < now) {
      c.overdue = addMoney(c.overdue, balance);
      c.overdueCount += 1;
    }
    byCurrency.set(r.currency, c);
  }
  return { totals: [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v })) };
});

export const invoices: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_invoices': m0001 },
  start: () => every(60 * 60_000, 'invoices.overdue', flagOverdueInvoices),
};
