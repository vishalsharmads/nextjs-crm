import { z } from 'zod';
import { toPatch } from '@app/shared';
import {
  AppError,
  assertCan,
  audit,
  db,
  defineRoutes,
  emit,
  escapeLike,
  iso,
  newUuid,
  notFound,
  notify,
  registerModuleWidget,
  resolveLinks,
  userRefs,
  type ApiModule,
  type AuthUser,
  type Db,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_assets';

const ASSETS = 'm_assets_assets';
const EVENTS = 'm_assets_events';
const STOCK = 'm_assets_stock';
const MOVES = 'm_assets_movements';

// ---------- Assets ----------

const assetBody = z.object({
  tag: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).default(''),
  serial: z.string().trim().max(120).default(''),
  location: z.string().trim().max(150).default(''),
  purchasedOn: z.iso.date().nullish(),
  purchaseCost: z.coerce.number().min(0).max(1e10).nullish(),
  notes: z.string().max(5000).nullish(),
});

async function assetDtos(rows: Record<string, unknown>[]) {
  const contactIds = [
    ...new Set(rows.map((r) => r.contact_id).filter((v): v is number => typeof v === 'number')),
  ];
  const contacts = contactIds.length
    ? new Map(
        (await db('contacts').whereIn('id', contactIds).select('id', 'uuid', 'full_name')).map((c) => [
          c.id as number,
          { uuid: c.uuid as string, name: c.full_name as string },
        ]),
      )
    : new Map<number, { uuid: string; name: string }>();
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => ({
    uuid: r.uuid as string,
    tag: r.tag as string,
    name: r.name as string,
    category: r.category as string,
    serial: r.serial as string,
    location: r.location as string,
    status: r.status as string,
    assignedTo: contacts.get(r.contact_id as number) ?? null,
    assignedAt: iso(r.assigned_at),
    dueBack: (r.due_back as string | null) ?? null,
    overdue: r.status === 'assigned' && !!r.due_back && (r.due_back as string) < today,
    purchasedOn: (r.purchased_on as string | null) ?? null,
    purchaseCost: r.purchase_cost === null || r.purchase_cost === undefined ? null : Number(r.purchase_cost),
    notes: (r.notes as string | null) ?? null,
  }));
}

const tagTaken = (err: unknown) =>
  (err as { code?: string }).code === 'ER_DUP_ENTRY'
    ? new AppError('CONFLICT', 'Another item already uses this tag or SKU', [
        { path: 'tag', message: 'Already used' },
      ])
    : err;

async function lockAsset(trx: Db, uuid: string) {
  const row = await trx(ASSETS).where({ uuid }).forUpdate().first();
  if (!row) throw notFound('Asset');
  return row as Record<string, unknown> & { id: number; status: string };
}

async function logEvent(
  trx: Db,
  assetId: number,
  kind: string,
  user: AuthUser,
  contactId: number | null,
  note?: string | null,
) {
  await trx(EVENTS).insert({
    asset_id: assetId,
    kind,
    contact_id: contactId,
    note: note ?? null,
    user_id: user.id,
  });
}

const uuidParam = z.object({ uuid: z.uuid() });

const assetRoutes = defineRoutes('/m/assets/assets', ['assets'], 'assets')
  .add({
    method: 'get',
    path: '/',
    permission: 'assets.assets.view',
    query: z.object({
      q: z.string().max(100).optional(),
      status: z.enum(['available', 'assigned', 'maintenance', 'retired', 'overdue']).optional(),
      category: z.string().max(100).optional(),
      contactUuid: z.uuid().optional(),
    }),
    handler: async ({ query }) => {
      const qb = db(ASSETS);
      if (query.status === 'overdue')
        qb.where({ status: 'assigned' }).where('due_back', '<', new Date().toISOString().slice(0, 10));
      else if (query.status) qb.where({ status: query.status });
      else qb.whereNot({ status: 'retired' });
      if (query.category) qb.where({ category: query.category });
      if (query.contactUuid)
        qb.whereIn('contact_id', db('contacts').where({ uuid: query.contactUuid }).select('id'));
      if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        qb.where((w) =>
          w.where('tag', 'like', like).orWhere('name', 'like', like).orWhere('serial', 'like', like),
        );
      }
      const rows = await qb.orderBy('tag').limit(1000);
      const categories = (
        await db(ASSETS).distinct('category').whereNot({ category: '' }).orderBy('category')
      ).map((r) => r.category as string);
      return { data: await assetDtos(rows), categories };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'assets.assets.view',
    params: uuidParam,
    handler: async ({ params }) => {
      const row = await db(ASSETS).where({ uuid: params.uuid }).first();
      if (!row) throw notFound('Asset');
      const events = await db(`${EVENTS} as e`)
        .leftJoin('contacts as c', 'c.id', 'e.contact_id')
        .where('e.asset_id', row.id)
        .orderBy('e.id', 'desc')
        .limit(200)
        .select('e.*', 'c.uuid as contact_uuid', 'c.full_name as contact_name');
      const users = await userRefs(events.map((e) => e.user_id as number | null));
      const [dto] = await assetDtos([row]);
      return {
        ...dto,
        history: events.map((e) => ({
          kind: e.kind as string,
          contact: e.contact_uuid ? { uuid: e.contact_uuid as string, name: e.contact_name as string } : null,
          note: (e.note as string | null) ?? null,
          by: users.get(e.user_id as number) ?? null,
          at: iso(e.created_at)!,
        })),
      };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'assets.assets.manage',
    body: assetBody,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      const uuid = newUuid();
      try {
        await db.transaction(async (trx) => {
          const [id] = await trx(ASSETS).insert({
            uuid,
            tag: body.tag,
            name: body.name,
            category: body.category,
            serial: body.serial,
            location: body.location,
            purchased_on: body.purchasedOn ?? null,
            purchase_cost: body.purchaseCost ?? null,
            notes: body.notes ?? null,
          });
          await logEvent(trx, id!, 'created', user, null);
          await audit(trx, ctx, {
            action: 'assets.asset.created',
            entity: 'assets.asset',
            entityId: id,
            entityUuid: uuid,
            diff: { tag: body.tag, name: body.name },
          });
        });
      } catch (err) {
        throw tagTaken(err);
      }
      return (await assetDtos([await db(ASSETS).where({ uuid }).first()]))[0];
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'assets.assets.manage',
    params: uuidParam,
    body: toPatch(assetBody),
    handler: async ({ ctx, params, body }) => {
      try {
        await db.transaction(async (trx) => {
          const row = await lockAsset(trx, params.uuid);
          const patch: Record<string, unknown> = { updated_at: new Date() };
          for (const [k, col] of [
            ['tag', 'tag'],
            ['name', 'name'],
            ['category', 'category'],
            ['serial', 'serial'],
            ['location', 'location'],
            ['purchasedOn', 'purchased_on'],
            ['purchaseCost', 'purchase_cost'],
            ['notes', 'notes'],
          ] as const)
            if (body[k] !== undefined) patch[col] = body[k];
          await trx(ASSETS).where({ id: row.id }).update(patch);
          await audit(trx, ctx, {
            action: 'assets.asset.updated',
            entity: 'assets.asset',
            entityId: row.id,
            entityUuid: params.uuid,
            diff: body,
          });
        });
      } catch (err) {
        throw tagTaken(err);
      }
      return (await assetDtos([await db(ASSETS).where({ uuid: params.uuid }).first()]))[0];
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/assign',
    permission: 'assets.assets.manage',
    params: uuidParam,
    body: z.object({
      contactUuid: z.uuid(),
      dueBack: z.iso.date().nullish(),
      note: z.string().trim().max(1000).nullish(),
    }),
    summary: 'Lend an available asset to a contact.',
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await lockAsset(trx, params.uuid);
        if (row.status !== 'available')
          throw new AppError('CONFLICT', `${row.tag} is ${row.status}, not available`);
        const { contact_id } = await resolveLinks(user, { contactUuid: body.contactUuid }, trx);
        await trx(ASSETS)
          .where({ id: row.id })
          .update({
            status: 'assigned',
            contact_id,
            assigned_at: new Date(),
            due_back: body.dueBack ?? null,
            updated_at: new Date(),
          });
        await logEvent(trx, row.id, 'assigned', user, contact_id ?? null, body.note);
        await audit(trx, ctx, {
          action: 'assets.asset.assigned',
          entity: 'assets.asset',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { contact: body.contactUuid, dueBack: body.dueBack ?? null },
        });
      });
      const [dto] = await assetDtos([await db(ASSETS).where({ uuid: params.uuid }).first()]);
      await emit({
        type: 'asset.assigned',
        entity: 'asset',
        uuid: params.uuid,
        record: dto as unknown as Record<string, unknown>,
        actorId: user.id,
      });
      return dto;
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/return',
    permission: 'assets.assets.manage',
    params: uuidParam,
    body: z.object({
      note: z.string().trim().max(1000).nullish(),
      needsMaintenance: z.boolean().default(false),
    }),
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await lockAsset(trx, params.uuid);
        if (row.status !== 'assigned') throw new AppError('CONFLICT', `${row.tag} is not lent out`);
        await trx(ASSETS)
          .where({ id: row.id })
          .update({
            status: body.needsMaintenance ? 'maintenance' : 'available',
            contact_id: null,
            assigned_at: null,
            due_back: null,
            updated_at: new Date(),
          });
        await logEvent(trx, row.id, 'returned', user, (row.contact_id as number | null) ?? null, body.note);
        await audit(trx, ctx, {
          action: 'assets.asset.returned',
          entity: 'assets.asset',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { needsMaintenance: body.needsMaintenance },
        });
      });
      const [dto] = await assetDtos([await db(ASSETS).where({ uuid: params.uuid }).first()]);
      await emit({
        type: 'asset.returned',
        entity: 'asset',
        uuid: params.uuid,
        record: dto as unknown as Record<string, unknown>,
        actorId: user.id,
      });
      return dto;
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/status',
    permission: 'assets.assets.manage',
    params: uuidParam,
    body: z.object({
      status: z.enum(['available', 'maintenance', 'retired']),
      note: z.string().trim().max(1000).nullish(),
    }),
    summary: 'Send for maintenance, bring back into service, or retire. Lent assets must be returned first.',
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await lockAsset(trx, params.uuid);
        if (row.status === 'assigned') throw new AppError('CONFLICT', 'Return it before changing its status');
        if (row.status === body.status) return;
        await trx(ASSETS).where({ id: row.id }).update({ status: body.status, updated_at: new Date() });
        await logEvent(trx, row.id, body.status, user, null, body.note);
        await audit(trx, ctx, {
          action: 'assets.asset.status_changed',
          entity: 'assets.asset',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { status: { from: row.status, to: body.status } },
        });
      });
      return (await assetDtos([await db(ASSETS).where({ uuid: params.uuid }).first()]))[0];
    },
  });

// ---------- Stock ----------

const stockBody = z.object({
  sku: z.string().trim().max(64).nullish(),
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(30).default(''),
  location: z.string().trim().max(150).default(''),
  reorderLevel: z.coerce.number().min(0).max(1e9).nullish(),
  active: z.boolean().default(true),
});

const stockDto = (r: Record<string, unknown>) => {
  const quantity = Number(r.quantity);
  const reorder = r.reorder_level === null || r.reorder_level === undefined ? null : Number(r.reorder_level);
  return {
    uuid: r.uuid as string,
    sku: (r.sku as string | null) ?? null,
    name: r.name as string,
    unit: r.unit as string,
    location: r.location as string,
    quantity,
    reorderLevel: reorder,
    low: reorder !== null && quantity <= reorder,
    active: !!r.active,
  };
};

const stockRoutes = defineRoutes('/m/assets/stock', ['assets'], 'assets')
  .add({
    method: 'get',
    path: '/',
    permission: 'assets.assets.view',
    query: z.object({ q: z.string().max(100).optional(), low: z.enum(['true']).optional() }),
    handler: async ({ query }) => {
      const qb = db(STOCK).where({ active: true });
      if (query.low) qb.whereNotNull('reorder_level').whereRaw('quantity <= reorder_level');
      if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        qb.where((w) => w.where('name', 'like', like).orWhere('sku', 'like', like));
      }
      return { data: (await qb.orderBy('name').limit(1000)).map(stockDto) };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'assets.assets.view',
    params: uuidParam,
    handler: async ({ params }) => {
      const row = await db(STOCK).where({ uuid: params.uuid }).first();
      if (!row) throw notFound('Stock item');
      const moves = await db(MOVES).where({ stock_id: row.id }).orderBy('id', 'desc').limit(200);
      const users = await userRefs(moves.map((m) => m.user_id as number | null));
      return {
        ...stockDto(row),
        movements: moves.map((m) => ({
          kind: m.kind as string,
          quantity: Number(m.quantity),
          balanceAfter: Number(m.balance_after),
          reason: (m.reason as string | null) ?? null,
          by: users.get(m.user_id as number) ?? null,
          at: iso(m.created_at)!,
        })),
      };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'assets.stock.manage',
    body: stockBody.extend({ quantity: z.coerce.number().min(0).max(1e9).default(0) }),
    status: 201,
    handler: async ({ ctx, user, body }) => {
      const uuid = newUuid();
      try {
        await db.transaction(async (trx) => {
          const [id] = await trx(STOCK).insert({
            uuid,
            sku: body.sku || null,
            name: body.name,
            unit: body.unit,
            location: body.location,
            quantity: body.quantity,
            reorder_level: body.reorderLevel ?? null,
            active: body.active,
          });
          if (body.quantity)
            await trx(MOVES).insert({
              stock_id: id,
              kind: 'in',
              quantity: body.quantity,
              balance_after: body.quantity,
              reason: 'Opening stock',
              user_id: user.id,
            });
          await audit(trx, ctx, {
            action: 'assets.stock.created',
            entity: 'assets.stock',
            entityId: id,
            entityUuid: uuid,
            diff: { name: body.name, quantity: body.quantity },
          });
        });
      } catch (err) {
        throw tagTaken(err);
      }
      return stockDto(await db(STOCK).where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'assets.stock.manage',
    params: uuidParam,
    body: toPatch(stockBody),
    handler: async ({ ctx, params, body }) => {
      try {
        await db.transaction(async (trx) => {
          const row = await trx(STOCK).where({ uuid: params.uuid }).forUpdate().first();
          if (!row) throw notFound('Stock item');
          const patch: Record<string, unknown> = { updated_at: new Date() };
          if (body.sku !== undefined) patch.sku = body.sku || null;
          if (body.name !== undefined) patch.name = body.name;
          if (body.unit !== undefined) patch.unit = body.unit;
          if (body.location !== undefined) patch.location = body.location;
          if (body.reorderLevel !== undefined) {
            patch.reorder_level = body.reorderLevel;
            patch.low_notified_at = null;
          }
          if (body.active !== undefined) patch.active = body.active;
          await trx(STOCK).where({ id: row.id }).update(patch);
          await audit(trx, ctx, {
            action: 'assets.stock.updated',
            entity: 'assets.stock',
            entityId: row.id,
            entityUuid: params.uuid,
            diff: body,
          });
        });
      } catch (err) {
        throw tagTaken(err);
      }
      return stockDto(await db(STOCK).where({ uuid: params.uuid }).first());
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/movements',
    permission: 'assets.stock.manage',
    params: uuidParam,
    body: z.object({
      kind: z.enum(['in', 'out', 'adjust']),
      quantity: z.coerce.number().min(0).max(1e9),
      reason: z.string().trim().max(500).nullish(),
    }),
    summary: '`in` and `out` add or remove; `adjust` sets the counted quantity. Stock cannot go below zero.',
    handler: async ({ ctx, user, params, body }) => {
      let crossedLow = false;
      await db.transaction(async (trx) => {
        const row = await trx(STOCK).where({ uuid: params.uuid }).forUpdate().first();
        if (!row) throw notFound('Stock item');
        if (body.kind !== 'adjust' && body.quantity <= 0)
          throw new AppError('VALIDATION_FAILED', 'Enter a quantity above zero', [
            { path: 'quantity', message: 'Must be above zero' },
          ]);
        const current = Number(row.quantity);
        const next =
          body.kind === 'in'
            ? current + body.quantity
            : body.kind === 'out'
              ? current - body.quantity
              : body.quantity;
        if (next < 0)
          throw new AppError('VALIDATION_FAILED', `Only ${current} in stock`, [
            { path: 'quantity', message: `At most ${current}` },
          ]);
        const balance = Math.round(next * 1000) / 1000;
        const reorder = row.reorder_level === null ? null : Number(row.reorder_level);
        const patch: Record<string, unknown> = { quantity: balance, updated_at: new Date() };
        if (reorder !== null && balance <= reorder && !row.low_notified_at) {
          patch.low_notified_at = new Date();
          crossedLow = true;
        }
        if (reorder !== null && balance > reorder) patch.low_notified_at = null;
        await trx(STOCK).where({ id: row.id }).update(patch);
        await trx(MOVES).insert({
          stock_id: row.id,
          kind: body.kind,
          quantity: body.kind === 'adjust' ? balance - current : body.quantity,
          balance_after: balance,
          reason: body.reason ?? null,
          user_id: user.id,
        });
        await audit(trx, ctx, {
          action: 'assets.stock.moved',
          entity: 'assets.stock',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { kind: body.kind, quantity: body.quantity, balance },
        });
      });
      const dto = stockDto(await db(STOCK).where({ uuid: params.uuid }).first());
      if (crossedLow) {
        await emit({
          type: 'stock.low',
          entity: 'stock',
          uuid: params.uuid,
          record: dto as unknown as Record<string, unknown>,
          actorId: user.id,
        });
        await notify(user.id, {
          type: 'stock.low',
          title: `${dto.name} is running low`,
          body: `${dto.quantity} ${dto.unit} left`.trim(),
          link: '/m/assets?tab=stock',
          email: false,
        });
      }
      return dto;
    },
  });

registerModuleWidget('assets.overview', async (_params, user) => {
  assertCan(user, 'assets.assets.view');
  const today = new Date().toISOString().slice(0, 10);
  const counts = await db(ASSETS)
    .whereNot({ status: 'retired' })
    .select('status')
    .count({ c: '*' })
    .groupBy('status');
  const byStatus = Object.fromEntries(
    (counts as { status: string; c: number | string }[]).map((r) => [r.status, Number(r.c)]),
  );
  const overdue = Number(
    (
      (await db(ASSETS)
        .where({ status: 'assigned' })
        .where('due_back', '<', today)
        .count({ c: '*' })
        .first()) as { c: number }
    ).c,
  );
  const low = await db(STOCK)
    .where({ active: true })
    .whereNotNull('reorder_level')
    .whereRaw('quantity <= reorder_level')
    .orderBy('name')
    .limit(5);
  return {
    available: byStatus.available ?? 0,
    assigned: byStatus.assigned ?? 0,
    maintenance: byStatus.maintenance ?? 0,
    overdue,
    lowStock: low.map(stockDto),
  };
});

export const assets: ApiModule = {
  routes: () => [assetRoutes, stockRoutes],
  migrations: { '0001_assets': m0001 },
};
