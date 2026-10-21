import { toPatch } from '@app/shared';
import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { conflict, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { slugify } from '../records/hydrate';

const tagBody = z.object({ name: z.string().trim().min(1).max(64), color: z.string().max(32).nullish() });

export const tagsRoutes = defineRoutes('/tags', ['tags'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.tags.view',
    query: z.object({ q: z.string().max(64).optional() }),
    handler: async ({ query }) => {
      const qb = db('tags as t')
        .leftJoin('taggables as tg', 'tg.tag_id', 't.id')
        .groupBy('t.id')
        .orderBy('t.name')
        .select('t.uuid', 't.name', 't.slug', 't.color')
        .count({ usage: 'tg.tag_id' });
      if (query.q) qb.where('t.name', 'like', `${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      return { data: (await qb).map((t) => ({ ...t, usage: Number(t.usage) })) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.tags.manage',
    body: tagBody,
    status: 201,
    handler: async ({ ctx, body }) => {
      const slug = slugify(body.name);
      if (await db('tags').where({ slug }).first()) throw conflict('A tag with this name already exists');
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('tags').insert({ uuid, name: body.name, slug, color: body.color ?? null });
        await audit(trx, ctx, {
          action: 'tag.created',
          entity: 'tag',
          entityId: id,
          entityUuid: uuid,
          diff: body,
        });
      });
      return { uuid, name: body.name, slug, color: body.color ?? null };
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.tags.manage',
    params: z.object({ uuid: z.uuid() }),
    body: toPatch(tagBody),
    handler: async ({ ctx, params, body }) => {
      const tag = await db('tags').where({ uuid: params.uuid }).first();
      if (!tag) throw notFound('Tag');
      const patch: Record<string, unknown> = {};
      if (body.name) {
        patch.name = body.name;
        patch.slug = slugify(body.name);
        if (await db('tags').where({ slug: patch.slug }).whereNot({ id: tag.id }).first())
          throw conflict('A tag with this name already exists');
      }
      if (body.color !== undefined) patch.color = body.color;
      await db.transaction(async (trx) => {
        await trx('tags').where({ id: tag.id }).update(patch);
        await audit(trx, ctx, {
          action: 'tag.updated',
          entity: 'tag',
          entityId: tag.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return { ...(await db('tags').where({ id: tag.id }).first('uuid', 'name', 'slug', 'color')) };
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.tags.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, params }) => {
      const tag = await db('tags').where({ uuid: params.uuid }).first();
      if (!tag) throw notFound('Tag');
      await db.transaction(async (trx) => {
        await trx('tags').where({ id: tag.id }).delete();
        await audit(trx, ctx, {
          action: 'tag.deleted',
          entity: 'tag',
          entityId: tag.id,
          entityUuid: params.uuid,
          diff: { name: tag.name },
        });
      });
    },
  });
