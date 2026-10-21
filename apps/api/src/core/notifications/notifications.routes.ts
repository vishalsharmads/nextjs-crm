import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { notFound } from '../../lib/errors';
import { iso } from '../records/hydrate';

export const notificationsRoutes = defineRoutes('/notifications', ['notifications'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    query: z.object({
      unread: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
    handler: async ({ user, query }) => {
      const q = db('notifications')
        .where({ user_id: user.id })
        .orderBy('created_at', 'desc')
        .limit(query.limit);
      if (query.unread) q.whereNull('read_at');
      const rows = await q;
      return {
        data: rows.map((n) => ({
          uuid: n.uuid,
          type: n.type,
          title: n.title,
          body: n.body,
          link: n.link,
          data: n.data,
          readAt: iso(n.read_at),
          createdAt: iso(n.created_at),
        })),
      };
    },
  })
  .add({
    method: 'get',
    path: '/unread-count',
    permission: 'authenticated',
    handler: async ({ user }) => {
      const row = await db('notifications')
        .where({ user_id: user.id })
        .whereNull('read_at')
        .count({ c: '*' })
        .first();
      return { count: Number((row as { c: number }).c) };
    },
  })
  .add({
    method: 'post',
    path: '/read-all',
    permission: 'authenticated',
    handler: async ({ user }) => {
      await db('notifications')
        .where({ user_id: user.id })
        .whereNull('read_at')
        .update({ read_at: new Date() });
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/read',
    permission: 'authenticated',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ user, params }) => {
      const n = await db('notifications')
        .where({ uuid: params.uuid, user_id: user.id })
        .update({ read_at: new Date() });
      if (!n) throw notFound('Notification');
    },
  });
