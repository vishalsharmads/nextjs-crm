import { z } from 'zod';
import { formatDocNumber, toPatch } from '@app/shared';
import {
  AppError,
  addDays,
  addMonths,
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
  newUuid,
  nextDocNumber,
  notFound,
  notify,
  registerModuleWidget,
  resolveLinks,
  scopeAllows,
  systemContext,
  todayIn,
  userIdFromRef,
  userRefs,
  type ApiModule,
  type AuthUser,
  type Db,
  type Knex,
  type RequestContext,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_contracts';

const CONTRACTS = 'm_contracts_contracts';
const RESOURCE = 'contracts.contracts';
const dateStr = z.iso.date();

const contractBody = z.object({
  title: z.string().trim().min(1).max(200),
  contactUuid: z.uuid().nullish(),
  organizationUuid: z.uuid().nullish(),
  dealUuid: z.uuid().nullish(),
  ownerUuid: z.string().max(36).nullish(),
  startDate: dateStr.nullish(),
  endDate: dateStr.nullish(),
  signedOn: dateStr.nullish(),
  currency: z.string().length(3).toUpperCase().optional(),
  value: z.coerce.number().min(0).max(1e13).default(0),
  billingCycle: z.enum(['none', 'monthly', 'quarterly', 'yearly']).default('none'),
  autoRenew: z.boolean().default(false),
  renewalTermMonths: z.coerce.number().int().min(1).max(120).default(12),
  noticeDays: z.coerce.number().int().min(1).max(365).nullish(),
  description: z.string().max(10000).nullish(),
  terms: z.string().max(20000).nullish(),
});
type ContractBody = z.output<typeof contractBody>;

/** Editable once active: business details only. Dates and value are fixed; renew to change them. */
const ACTIVE_EDITABLE = new Set([
  'title',
  'ownerUuid',
  'autoRenew',
  'renewalTermMonths',
  'noticeDays',
  'description',
  'contactUuid',
  'organizationUuid',
  'dealUuid',
  'signedOn',
]);

function checkDates(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && end < start)
    throw new AppError('VALIDATION_FAILED', 'The end date is before the start date', [
      { path: 'endDate', message: 'Must be on or after the start date' },
    ]);
}

async function ownerFor(user: AuthUser, ref: string | null | undefined, conn: Db) {
  const id = await userIdFromRef(ref, user, conn);
  if (id === undefined || id === null) return id;
  if (id !== user.id && !(await scopeAllows(user, RESOURCE, [id], conn)))
    throw new AppError('FORBIDDEN', 'You can only assign contracts within your own access');
  return id;
}

async function today() {
  return todayIn((await getSettingsGroup('general')).timezone);
}

async function toDtos(rows: Record<string, unknown>[], viewer?: AuthUser) {
  const [refs, owners, commerce, now] = await Promise.all([
    linkRefs(rows, db, viewer),
    userRefs(rows.map((r) => r.owner_id as number | null)),
    getSettingsGroup('commerce'),
    today(),
  ]);
  const fromIds = rows.map((r) => r.renewed_from_id).filter((v): v is number => typeof v === 'number');
  const from = fromIds.length
    ? new Map(
        (await db(CONTRACTS).whereIn('id', fromIds).select('id', 'uuid', 'number')).map((r) => [
          r.id as number,
          { uuid: r.uuid as string, number: r.number as string },
        ]),
      )
    : new Map<number, { uuid: string; number: string }>();
  return rows.map((r) => {
    const end = (r.end_date as string | null) ?? null;
    const noticeDays = (r.notice_days as number | null) ?? commerce.renewalNoticeDays;
    const daysLeft = end ? Math.round((Date.parse(end) - Date.parse(now)) / 86_400_000) : null;
    return {
      uuid: r.uuid as string,
      number: r.number as string,
      title: r.title as string,
      status: r.status as string,
      ...refs(r),
      owner: owners.get(r.owner_id as number) ?? null,
      startDate: (r.start_date as string | null) ?? null,
      endDate: end,
      signedOn: (r.signed_on as string | null) ?? null,
      currency: r.currency as string,
      value: Number(r.value),
      billingCycle: r.billing_cycle as string,
      autoRenew: !!r.auto_renew,
      renewalTermMonths: r.renewal_term_months as number,
      noticeDays: (r.notice_days as number | null) ?? null,
      effectiveNoticeDays: noticeDays,
      daysLeft,
      renewalDue: r.status === 'active' && daysLeft !== null && daysLeft <= noticeDays,
      renewedFrom: from.get(r.renewed_from_id as number) ?? null,
      renewedToUuid: (r.renewed_to_uuid as string | null) ?? null,
      cancelledAt: iso(r.cancelled_at),
      cancelReason: (r.cancel_reason as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      terms: (r.terms as string | null) ?? null,
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    };
  });
}

async function getScoped(user: AuthUser, uuid: string, conn: Db = db, forUpdate = false) {
  const qb = conn(CONTRACTS).where({ uuid }).whereNull('deleted_at');
  await applyScope(qb, user, RESOURCE, ['owner_id'], conn);
  if (forUpdate) qb.forUpdate();
  const row = await qb.first();
  if (!row) throw notFound('Contract');
  return row as Record<string, unknown> & { id: number; uuid: string; status: string };
}

async function getDto(uuid: string, viewer?: AuthUser) {
  return (await toDtos([await db(CONTRACTS).where({ uuid }).first()], viewer))[0]!;
}

type ContractEvent =
  | 'contract.created'
  | 'contract.activated'
  | 'contract.renewal_due'
  | 'contract.renewed'
  | 'contract.expired'
  | 'contract.cancelled';
async function emitContract(type: ContractEvent, uuid: string, actorId: number | null) {
  const record = await getDto(uuid);
  await emit({
    type,
    entity: 'contract',
    uuid,
    record: record as unknown as Record<string, unknown>,
    actorId,
  });
}

function columns(b: Partial<ContractBody>) {
  const out: Record<string, unknown> = {};
  if (b.title !== undefined) out.title = b.title;
  if (b.startDate !== undefined) out.start_date = b.startDate;
  if (b.endDate !== undefined) out.end_date = b.endDate;
  if (b.signedOn !== undefined) out.signed_on = b.signedOn;
  if (b.currency !== undefined) out.currency = b.currency;
  if (b.value !== undefined) out.value = b.value;
  if (b.billingCycle !== undefined) out.billing_cycle = b.billingCycle;
  if (b.autoRenew !== undefined) out.auto_renew = b.autoRenew;
  if (b.renewalTermMonths !== undefined) out.renewal_term_months = b.renewalTermMonths;
  if (b.noticeDays !== undefined) out.notice_days = b.noticeDays;
  if (b.description !== undefined) out.description = b.description;
  if (b.terms !== undefined) out.terms = b.terms;
  return out;
}

/**
 * Renew: the next term starts the day after the current end date and runs for the renewal term.
 * The old contract becomes `renewed` and links forward; the new one is active straight away.
 */
async function renewContract(
  trx: Db,
  ctx: RequestContext,
  row: Record<string, unknown>,
  actorId: number | null,
) {
  if (!row.end_date) throw new AppError('CONFLICT', 'Open-ended contracts have nothing to renew');
  const commerce = await getSettingsGroup('commerce', trx);
  const start = addDays(row.end_date as string, 1);
  const end = addDays(addMonths(start, row.renewal_term_months as number), -1);
  const uuid = newUuid();
  const n = await nextDocNumber(trx, 'contract');
  const [id] = await trx(CONTRACTS).insert({
    uuid,
    number: formatDocNumber(commerce.contractPrefix, n),
    title: row.title,
    contact_id: row.contact_id,
    organization_id: row.organization_id,
    deal_id: row.deal_id,
    owner_id: row.owner_id,
    status: 'active',
    start_date: start,
    end_date: end,
    currency: row.currency,
    value: row.value,
    billing_cycle: row.billing_cycle,
    auto_renew: row.auto_renew,
    renewal_term_months: row.renewal_term_months,
    notice_days: row.notice_days,
    renewed_from_id: row.id,
    description: row.description,
    terms: row.terms,
    created_by: actorId,
  });
  await trx(CONTRACTS)
    .where({ id: row.id })
    .update({ status: 'renewed', renewed_to_uuid: uuid, updated_at: new Date() });
  await audit(trx, ctx, {
    action: 'contracts.contract.renewed',
    entity: 'contracts.contract',
    entityId: row.id as number,
    entityUuid: row.uuid as string,
    diff: { renewedTo: uuid, start, end },
  });
  await audit(trx, ctx, {
    action: 'contracts.contract.created',
    entity: 'contracts.contract',
    entityId: id,
    entityUuid: uuid,
    diff: { renewedFrom: row.number },
  });
  return uuid;
}

const uuidParam = z.object({ uuid: z.uuid() });

const routes = defineRoutes('/m/contracts/contracts', ['contracts'], 'contracts')
  .add({
    method: 'get',
    path: '/',
    permission: 'contracts.contracts.view',
    query: z.object({
      q: z.string().max(100).optional(),
      status: z.enum(['draft', 'active', 'expired', 'cancelled', 'renewed', 'renewing']).optional(),
      dealUuid: z.uuid().optional(),
      organizationUuid: z.uuid().optional(),
      contactUuid: z.uuid().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
    handler: async ({ user, query }) => {
      const qb = db(CONTRACTS).whereNull('deleted_at');
      await applyScope(qb, user, RESOURCE, ['owner_id']);
      if (query.status === 'renewing') {
        const { renewalNoticeDays } = await getSettingsGroup('commerce');
        const now = await today();
        // Ending within each contract's notice window (its own, or the workspace default).
        qb.where({ status: 'active' })
          .whereNotNull('end_date')
          .whereRaw('end_date <= DATE_ADD(?, INTERVAL COALESCE(notice_days, ?) DAY)', [
            now,
            renewalNoticeDays,
          ]);
      } else if (query.status) qb.where({ status: query.status });
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
        .orderByRaw(query.status === 'renewing' ? 'end_date ASC' : 'id DESC')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return { data: await toDtos(rows, user), meta: { page: query.page, pageSize: query.pageSize, total } };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'contracts.contracts.view',
    params: uuidParam,
    handler: async ({ user, params }) => (await toDtos([await getScoped(user, params.uuid)], user))[0],
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'contracts.contracts.create',
    body: contractBody,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      checkDates(body.startDate, body.endDate);
      const [general, commerce] = await Promise.all([
        getSettingsGroup('general'),
        getSettingsGroup('commerce'),
      ]);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const links = await resolveLinks(user, body, trx);
        const ownerId = (await ownerFor(user, body.ownerUuid, trx)) ?? user.id;
        const n = await nextDocNumber(trx, 'contract');
        const [id] = await trx(CONTRACTS).insert({
          uuid,
          number: formatDocNumber(commerce.contractPrefix, n),
          ...columns(body),
          ...links,
          owner_id: ownerId,
          currency: body.currency ?? general.currency,
          status: 'draft',
          created_by: user.id,
        });
        await audit(trx, ctx, {
          action: 'contracts.contract.created',
          entity: 'contracts.contract',
          entityId: id,
          entityUuid: uuid,
          diff: { title: body.title, value: body.value },
        });
      });
      await emitContract('contract.created', uuid, user.id);
      return getDto(uuid, user);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'contracts.contracts.update',
    params: uuidParam,
    body: toPatch(contractBody),
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'draft' && row.status !== 'active')
          throw new AppError('CONFLICT', `A ${row.status} contract cannot be edited`);
        if (row.status === 'active') {
          const locked = Object.keys(body).filter((k) => !ACTIVE_EDITABLE.has(k));
          if (locked.length)
            throw new AppError(
              'CONFLICT',
              'Dates, value and terms of an active contract are fixed. Renew or cancel it instead.',
              locked.map((path) => ({ path, message: 'Locked while active' })),
            );
        }
        checkDates(
          body.startDate === undefined ? (row.start_date as string | null) : body.startDate,
          body.endDate === undefined ? (row.end_date as string | null) : body.endDate,
        );
        const patch: Record<string, unknown> = { ...columns(body), ...(await resolveLinks(user, body, trx)) };
        const owner = await ownerFor(user, body.ownerUuid, trx);
        if (owner !== undefined) patch.owner_id = owner;
        // Moving the end date re-arms the renewal reminder.
        if (body.endDate !== undefined || body.noticeDays !== undefined) patch.renewal_reminded_at = null;
        await trx(CONTRACTS)
          .where({ id: row.id })
          .update({ ...patch, updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'contracts.contract.updated',
          entity: 'contracts.contract',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return getDto(params.uuid, user);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/activate',
    permission: 'contracts.contracts.update',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'draft') throw new AppError('CONFLICT', 'Only draft contracts can be activated');
        if (!row.start_date)
          throw new AppError('VALIDATION_FAILED', 'Set a start date before activating', [
            { path: 'startDate', message: 'Required to activate' },
          ]);
        await trx(CONTRACTS).where({ id: row.id }).update({ status: 'active', updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'contracts.contract.activated',
          entity: 'contracts.contract',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
      await emitContract('contract.activated', params.uuid, user.id);
      return getDto(params.uuid, user);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/renew',
    permission: 'contracts.contracts.update',
    params: uuidParam,
    status: 201,
    summary: 'Start the next term now. Returns the new contract.',
    handler: async ({ ctx, user, params }) => {
      assertCan(user, 'contracts.contracts.create');
      const uuid = await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'active' && row.status !== 'expired')
          throw new AppError('CONFLICT', `A ${row.status} contract cannot be renewed`);
        return renewContract(trx, ctx, row, user.id);
      });
      await emitContract('contract.renewed', params.uuid, user.id);
      return getDto(uuid, user);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/cancel',
    permission: 'contracts.contracts.update',
    params: uuidParam,
    body: z.object({ reason: z.string().trim().min(1).max(500) }),
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'active') throw new AppError('CONFLICT', 'Only active contracts can be cancelled');
        await trx(CONTRACTS).where({ id: row.id }).update({
          status: 'cancelled',
          cancelled_at: new Date(),
          cancel_reason: body.reason,
          auto_renew: false,
          updated_at: new Date(),
        });
        await audit(trx, ctx, {
          action: 'contracts.contract.cancelled',
          entity: 'contracts.contract',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { reason: body.reason },
        });
      });
      await emitContract('contract.cancelled', params.uuid, user.id);
      return getDto(params.uuid, user);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'contracts.contracts.delete',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        if (row.status !== 'draft')
          throw new AppError('CONFLICT', 'Only draft contracts can be deleted. Cancel it instead.');
        await trx(CONTRACTS).where({ id: row.id }).update({ deleted_at: new Date() });
        await audit(trx, ctx, {
          action: 'contracts.contract.deleted',
          entity: 'contracts.contract',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
    },
  });

/**
 * Daily housekeeping:
 * 1. Active contracts inside their notice window get one reminder (`contract.renewal_due` + owner notification).
 * 2. Active contracts past their end date renew automatically (auto-renew) or expire.
 */
export async function runRenewals() {
  if (!isModuleEnabled('contracts')) return { reminded: 0, renewed: 0, expired: 0 };
  const ctx = systemContext('job:contracts.renewals');
  const now = await today();
  const { renewalNoticeDays } = await getSettingsGroup('commerce');
  const out = { reminded: 0, renewed: 0, expired: 0 };

  const due = await db(CONTRACTS)
    .where({ status: 'active' })
    .whereNull('deleted_at')
    .whereNull('renewal_reminded_at')
    .whereNotNull('end_date')
    .where('end_date', '>=', now)
    .whereRaw('end_date <= DATE_ADD(?, INTERVAL COALESCE(notice_days, ?) DAY)', [now, renewalNoticeDays])
    .limit(500);
  for (const c of due) {
    const n = await db(CONTRACTS)
      .where({ id: c.id })
      .whereNull('renewal_reminded_at')
      .update({ renewal_reminded_at: new Date() });
    if (!n) continue;
    out.reminded += 1;
    if (c.owner_id)
      await notify(c.owner_id as number, {
        type: 'contract.renewal_due',
        title: `${c.number} ${c.auto_renew ? 'renews' : 'ends'} on ${c.end_date}`,
        body: c.title as string,
        link: `/m/contracts/${c.uuid}`,
        email: true,
      });
    await emitContract('contract.renewal_due', c.uuid as string, null);
  }

  const ended = await db(CONTRACTS)
    .where({ status: 'active' })
    .whereNull('deleted_at')
    .whereNotNull('end_date')
    .where('end_date', '<', now)
    .limit(500);
  for (const c of ended) {
    if (c.auto_renew) {
      const renewed = await db.transaction(async (trx) => {
        const row = await trx(CONTRACTS).where({ id: c.id, status: 'active' }).forUpdate().first();
        return row ? renewContract(trx, ctx, row, null) : null;
      });
      if (renewed) {
        out.renewed += 1;
        await emitContract('contract.renewed', c.uuid as string, null);
      }
    } else {
      const n = await db.transaction(async (trx) => {
        const updated = await trx(CONTRACTS)
          .where({ id: c.id, status: 'active' })
          .update({ status: 'expired', updated_at: new Date() });
        if (updated)
          await audit(trx, ctx, {
            action: 'contracts.contract.expired',
            entity: 'contracts.contract',
            entityId: c.id as number,
            entityUuid: c.uuid as string,
          });
        return updated;
      });
      if (n) {
        out.expired += 1;
        await emitContract('contract.expired', c.uuid as string, null);
      }
    }
  }
  return out;
}

registerModuleWidget('contracts.renewals', async (_params, user) => {
  assertCan(user, 'contracts.contracts.view');
  const now = await today();
  const qb = db(CONTRACTS)
    .whereNull('deleted_at')
    .where({ status: 'active' })
    .whereNotNull('end_date')
    .whereBetween('end_date', [now, addDays(now, 60)]);
  await applyScope(qb, user, RESOURCE, ['owner_id']);
  const rows = await qb.orderBy('end_date').limit(8);
  return {
    contracts: (await toDtos(rows, user)).map((c) => ({
      uuid: c.uuid,
      number: c.number,
      title: c.title,
      endDate: c.endDate,
      daysLeft: c.daysLeft,
      autoRenew: c.autoRenew,
      organization: c.organization,
    })),
  };
});

export const contracts: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_contracts': m0001 },
  start: () => every(60 * 60_000, 'contracts.renewals', runRenewals),
};

/** Contracts a customer may see: active or past, never drafts. */
export async function customerContracts(match: (qb: Knex.QueryBuilder) => void) {
  const qb = db(CONTRACTS).whereNull('deleted_at').whereNot({ status: 'draft' });
  match(qb);
  const rows = await qb.orderBy('id', 'desc').limit(100);
  return (await toDtos(rows)).map((c) => ({
    uuid: c.uuid,
    number: c.number,
    title: c.title,
    status: c.status,
    startDate: c.startDate,
    endDate: c.endDate,
    value: c.value,
    currency: c.currency,
    billingCycle: c.billingCycle,
    autoRenew: c.autoRenew,
  }));
}
