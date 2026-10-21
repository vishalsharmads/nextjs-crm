import { toPatch } from '@app/shared';
import { z } from 'zod';
import {
  AppError,
  audit,
  db,
  defineRoutes,
  escapeLike,
  newUuid,
  notFound,
  type ApiModule,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_products';

export const PRODUCTS_TABLE = 'm_products_products';

const productBody = z.object({
  sku: z.string().trim().max(64).nullish(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullish(),
  unit: z.string().trim().max(30).default(''),
  unitPrice: z.coerce.number().min(0).max(100_000_000),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  recurring: z.boolean().default(false),
  active: z.boolean().default(true),
});

const dto = (r: Record<string, unknown>) => ({
  uuid: r.uuid as string,
  sku: (r.sku as string | null) ?? null,
  name: r.name as string,
  description: (r.description as string | null) ?? null,
  unit: r.unit as string,
  unitPrice: Number(r.unit_price),
  taxRate: Number(r.tax_rate),
  recurring: !!r.recurring,
  active: !!r.active,
});

const columns = (b: Partial<z.output<typeof productBody>>) => {
  const out: Record<string, unknown> = {};
  if (b.sku !== undefined) out.sku = b.sku || null;
  if (b.name !== undefined) out.name = b.name;
  if (b.description !== undefined) out.description = b.description ?? null;
  if (b.unit !== undefined) out.unit = b.unit;
  if (b.unitPrice !== undefined) out.unit_price = b.unitPrice;
  if (b.taxRate !== undefined) out.tax_rate = b.taxRate;
  if (b.recurring !== undefined) out.recurring = b.recurring;
  if (b.active !== undefined) out.active = b.active;
  return out;
};

const skuTaken = (err: unknown) =>
  (err as { code?: string }).code === 'ER_DUP_ENTRY'
    ? new AppError('CONFLICT', 'Another product already uses this SKU', [
        { path: 'sku', message: 'Already used' },
      ])
    : err;

const routes = defineRoutes('/m/products/products', ['products'], 'products')
  .add({
    method: 'get',
    path: '/',
    permission: 'products.products.view',
    query: z.object({
      q: z.string().max(100).optional(),
      active: z.enum(['true', 'false', 'all']).default('true'),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }),
    handler: async ({ query }) => {
      const qb = db(PRODUCTS_TABLE);
      if (query.active !== 'all') qb.where({ active: query.active === 'true' });
      if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        qb.where((w) => w.where('name', 'like', like).orWhere('sku', 'like', like));
      }
      const total = Number(((await qb.clone().count({ c: '*' }).first()) as { c: number }).c);
      const rows = await qb
        .orderBy('name')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return { data: rows.map(dto), meta: { page: query.page, pageSize: query.pageSize, total } };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'products.products.view',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ params }) => {
      const row = await db(PRODUCTS_TABLE).where({ uuid: params.uuid }).first();
      if (!row) throw notFound('Product');
      return dto(row);
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'products.products.manage',
    body: productBody,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      const uuid = newUuid();
      try {
        await db.transaction(async (trx) => {
          const [id] = await trx(PRODUCTS_TABLE).insert({ uuid, ...columns(body), created_by: user.id });
          await audit(trx, ctx, {
            action: 'products.product.created',
            entity: 'products.product',
            entityId: id,
            entityUuid: uuid,
            diff: { name: body.name, unitPrice: body.unitPrice },
          });
        });
      } catch (err) {
        throw skuTaken(err);
      }
      return dto(await db(PRODUCTS_TABLE).where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'products.products.manage',
    params: z.object({ uuid: z.uuid() }),
    body: toPatch(productBody),
    handler: async ({ ctx, params, body }) => {
      try {
        await db.transaction(async (trx) => {
          const row = await trx(PRODUCTS_TABLE).where({ uuid: params.uuid }).forUpdate().first();
          if (!row) throw notFound('Product');
          await trx(PRODUCTS_TABLE)
            .where({ id: row.id })
            .update({ ...columns(body), updated_at: new Date() });
          await audit(trx, ctx, {
            action: 'products.product.updated',
            entity: 'products.product',
            entityId: row.id,
            entityUuid: params.uuid,
            diff: body,
          });
        });
      } catch (err) {
        throw skuTaken(err);
      }
      return dto(await db(PRODUCTS_TABLE).where({ uuid: params.uuid }).first());
    },
  });

export const products: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_products': m0001 },
};
