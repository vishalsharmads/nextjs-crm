import { z } from 'zod';
import { CUSTOMIZABLE_ENTITIES, filterSchema } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { can } from '../rbac/access';
import type { AuthUser } from '../../http/context';

const viewBody = z.object({
  entity: z.enum(CUSTOMIZABLE_ENTITIES),
  name: z.string().trim().min(1).max(100),
  filters: filterSchema.nullish(),
  columns: z.array(z.string().max(80)).max(50).nullish(),
  sort: z
    .array(z.object({ field: z.string().max(80), dir: z.enum(['asc', 'desc']) }))
    .max(5)
    .nullish(),
  isShared: z.boolean().default(false),
});

const dto = (v: Record<string, unknown>, user: AuthUser) => ({
  uuid: v.uuid,
  entity: v.entity,
  name: v.name,
  filters: v.filters ?? null,
  columns: v.columns ?? null,
  sort: v.sort ?? null,
  isShared: !!v.is_shared,
  mine: v.owner_id === user.id,
  sortOrder: v.sort_order,
});

async function editable(uuid: string, user: AuthUser) {
  const v = await db('saved_views').where({ uuid }).first();
  if (!v || (v.owner_id !== user.id && !(v.is_shared && can(user, 'core.saved_views.share'))))
    throw notFound('View');
  return v;
}

export const savedViewsRoutes = defineRoutes('/saved-views', ['saved-views'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    query: z.object({ entity: z.enum(CUSTOMIZABLE_ENTITIES) }),
    handler: async ({ user, query }) => {
      const rows = await db('saved_views')
        .where({ entity: query.entity })
        .where((w) => w.where({ owner_id: user.id }).orWhere({ is_shared: true }))
        .orderBy([{ column: 'is_shared', order: 'desc' }, { column: 'sort_order' }, { column: 'id' }]);
      return { data: rows.map((r) => dto(r, user)) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'authenticated',
    body: viewBody,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      if (body.isShared && !can(user, 'core.saved_views.share'))
        throw new AppError('FORBIDDEN', 'You cannot share views');
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('saved_views').insert({
          uuid,
          entity: body.entity,
          name: body.name,
          filters: body.filters ? JSON.stringify(body.filters) : null,
          columns: body.columns ? JSON.stringify(body.columns) : null,
          sort: body.sort ? JSON.stringify(body.sort) : null,
          owner_id: user.id,
          is_shared: body.isShared,
          customized: true,
        });
        await audit(trx, ctx, {
          action: 'saved_view.created',
          entity: 'saved_view',
          entityId: id,
          entityUuid: uuid,
          diff: { name: body.name, shared: body.isShared },
        });
      });
      return dto(await db('saved_views').where({ uuid }).first(), user);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'authenticated',
    params: z.object({ uuid: z.uuid() }),
    body: viewBody.omit({ entity: true }).partial(),
    handler: async ({ ctx, user, params, body }) => {
      const v = await editable(params.uuid, user);
      if (
        body.isShared !== undefined &&
        body.isShared !== !!v.is_shared &&
        !can(user, 'core.saved_views.share')
      )
        throw new AppError('FORBIDDEN', 'You cannot share views');
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.filters !== undefined) patch.filters = body.filters ? JSON.stringify(body.filters) : null;
      if (body.columns !== undefined) patch.columns = body.columns ? JSON.stringify(body.columns) : null;
      if (body.sort !== undefined) patch.sort = body.sort ? JSON.stringify(body.sort) : null;
      if (body.isShared !== undefined) patch.is_shared = body.isShared;
      await db.transaction(async (trx) => {
        await trx('saved_views').where({ id: v.id }).update(patch);
        await audit(trx, ctx, {
          action: 'saved_view.updated',
          entity: 'saved_view',
          entityId: v.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return dto(await db('saved_views').where({ id: v.id }).first(), user);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'authenticated',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, user, params }) => {
      const v = await editable(params.uuid, user);
      await db.transaction(async (trx) => {
        await trx('saved_views').where({ id: v.id }).delete();
        await audit(trx, ctx, {
          action: 'saved_view.deleted',
          entity: 'saved_view',
          entityId: v.id,
          entityUuid: params.uuid,
        });
      });
    },
  });
