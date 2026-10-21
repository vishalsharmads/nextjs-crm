import { z } from 'zod';
import { RELATED_TYPES, type ActivityDto } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { audit } from '../audit/audit.service';
import { applyScope, assertCan } from '../rbac/access';
import { getRow } from '../records/service';
import { recordRoutes, uuidParam } from '../records/routes';
import { recordDefs } from '../records/registry';
import { activitiesDef } from './activities.def';

async function setCompleted(
  ctx: Parameters<typeof audit>[1],
  user: Parameters<typeof getRow>[1],
  uuid: string,
  done: boolean,
): Promise<ActivityDto> {
  const row = await db.transaction(async (trx) => {
    const a = await getRow(activitiesDef, user, uuid, trx, { forUpdate: true });
    await trx('activities')
      .where({ id: a.id })
      .update({ completed_at: done ? new Date() : null, updated_by: user.id });
    await audit(trx, ctx, {
      action: 'activity.updated',
      entity: 'activity',
      entityId: a.id,
      entityUuid: uuid,
      diff: { completed: { from: !done, to: done } },
    });
    return trx('activities').where({ id: a.id }).first();
  });
  const [dto] = await activitiesDef.toDtos([row], { user, conn: db });
  return dto!;
}

export const activitiesRoutes = [
  defineRoutes('/activities', ['activities'])
    .add({
      method: 'get',
      path: '/for',
      permission: 'core.activities.view',
      summary: 'Activities on one record (visible to anyone who can see that record)',
      query: z.object({
        type: z.enum(RELATED_TYPES),
        uuid: z.uuid(),
        status: z.enum(['open', 'done', 'all']).default('all'),
      }),
      handler: async ({ user, query }) => {
        const parentDef = recordDefs[query.type];
        assertCan(user, `${parentDef.resource}.view`);
        const parent = await getRow(parentDef, user, query.uuid);
        const qb = db('activities')
          .whereNull('deleted_at')
          .where({ related_type: query.type, related_id: parent.id });
        if (query.status === 'open') qb.whereNull('completed_at');
        if (query.status === 'done') qb.whereNotNull('completed_at');
        const rows = await qb
          .orderByRaw('completed_at IS NOT NULL, COALESCE(due_at, start_at, created_at) ASC')
          .limit(200);
        return { data: await activitiesDef.toDtos(rows, { user, conn: db }) };
      },
    })
    .add({
      method: 'get',
      path: '/calendar',
      permission: 'core.activities.view',
      query: z.object({
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
        assignee: z.union([z.uuid(), z.literal('@me')]).optional(),
      }),
      handler: async ({ user, query }) => {
        const qb = db('activities')
          .whereNull('deleted_at')
          .whereNot('type', 'note')
          .where((w) =>
            w
              .whereBetween('start_at', [new Date(query.from), new Date(query.to)])
              .orWhereBetween('due_at', [new Date(query.from), new Date(query.to)]),
          );
        await applyScope(qb, user, activitiesDef.resource, activitiesDef.ownerColumns);
        if (query.assignee) {
          const uuid = query.assignee === '@me' ? user.uuid : query.assignee;
          qb.whereIn('assignee_id', db('users').select('id').where({ uuid }));
        }
        const rows = await qb.limit(1000);
        return { data: await activitiesDef.toDtos(rows, { user, conn: db }) };
      },
    })
    .add({
      method: 'post',
      path: '/:uuid/complete',
      permission: 'core.activities.update',
      params: uuidParam,
      handler: ({ ctx, user, params }) => setCompleted(ctx, user, params.uuid, true),
    })
    .add({
      method: 'post',
      path: '/:uuid/reopen',
      permission: 'core.activities.update',
      params: uuidParam,
      handler: ({ ctx, user, params }) => setCompleted(ctx, user, params.uuid, false),
    }),
  recordRoutes(activitiesDef, 'activities'),
];
