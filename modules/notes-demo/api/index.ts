import { z } from 'zod';
import {
  audit,
  db,
  defineRoutes,
  newUuid,
  notFound,
  registerModuleWidget,
  type ApiModule,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_notes';

const routes = defineRoutes('/m/notes-demo/notes', ['notes-demo'], 'notes-demo')
  .add({
    method: 'get',
    path: '/',
    permission: 'notes-demo.notes.view',
    handler: async () => ({
      data: await db('m_notes_demo_notes')
        .orderBy('id', 'desc')
        .limit(100)
        .select('uuid', 'title', 'body', 'created_at as createdAt'),
    }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'notes-demo.notes.manage',
    body: z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(5000).nullish() }),
    status: 201,
    handler: async ({ ctx, user, body }) => {
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('m_notes_demo_notes').insert({
          uuid,
          title: body.title,
          body: body.body ?? null,
          created_by: user.id,
        });
        await audit(trx, ctx, {
          action: 'notes-demo.note.created',
          entity: 'notes-demo.note',
          entityId: id,
          entityUuid: uuid,
        });
      });
      return { uuid, title: body.title, body: body.body ?? null };
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'notes-demo.notes.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, params }) => {
      await db.transaction(async (trx) => {
        const n = await trx('m_notes_demo_notes').where({ uuid: params.uuid }).delete();
        if (!n) throw notFound('Note');
        await audit(trx, ctx, {
          action: 'notes-demo.note.deleted',
          entity: 'notes-demo.note',
          entityUuid: params.uuid,
        });
      });
    },
  });

registerModuleWidget('notes-demo.latest', async () => ({
  notes: await db('m_notes_demo_notes').orderBy('id', 'desc').limit(5).select('uuid', 'title'),
}));

export const notesDemo: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_notes': m0001 },
};
