import { z } from 'zod';
import { RELATED_TYPES, dealMoveSchema, type ActivityDto } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { audit } from '../audit/audit.service';
import { applyScope, assertCan } from '../rbac/access';
import { emitRecordEvent, getRow } from '../records/service';
import { recordRoutes, uuidParam } from '../records/routes';
import { recordDefs } from '../records/registry';
import { activitiesDef } from './activities.def';
import { activityCommentRoutes } from './comments';
import { checklistRoutes } from './checklist';
import { spawnNextOccurrence } from './recurrence';
import { stageForCompletion } from './task-stage';
import { boardQuerySchema, loadBoard, moveToStage } from '../pipelines/board';
import { endOfStage, publicStageChanges, recordStageHistory } from '../pipelines/stage-engine';
import { getGroup } from '../settings/settings.service';
import { notFound } from '../../lib/errors';

async function assertTaskPipeline() {
  if (!(await getGroup('features')).taskPipeline) throw notFound('Task statuses');
}

async function setCompleted(
  ctx: Parameters<typeof audit>[1],
  user: Parameters<typeof getRow>[1],
  uuid: string,
  done: boolean,
): Promise<ActivityDto> {
  const row = await db.transaction(async (trx) => {
    const a = await getRow(activitiesDef, user, uuid, trx, { forUpdate: true });
    // With task statuses on, completing moves the task to the done stage and reopening moves it back.
    const stage = a.pipeline_id
      ? await stageForCompletion(trx, a.pipeline_id as number, done, (a.stage_id as number | null) ?? null)
      : null;
    await trx('activities')
      .where({ id: a.id })
      .update({
        completed_at: done ? ((a.completed_at as Date | null) ?? new Date()) : null,
        updated_by: user.id,
        ...(stage
          ? {
              stage_id: stage.id,
              stage_entered_at: new Date(),
              position: await endOfStage(trx, 'activity', stage.id),
            }
          : {}),
      });
    if (stage)
      await recordStageHistory(
        trx,
        'activity',
        [a.id],
        (a.stage_id as number | null) ?? null,
        stage.id,
        user.id,
      );
    await audit(trx, ctx, {
      action: 'activity.updated',
      entity: 'activity',
      entityId: a.id,
      entityUuid: uuid,
      diff: { completed: { from: !done, to: done } },
    });
    // Completing a recurring task creates the next one (only when it was open).
    const spawned = done && !a.completed_at ? await spawnNextOccurrence(trx, ctx, a.id) : null;
    return { row: await trx('activities').where({ id: a.id }).first(), spawned };
  });
  const [dto] = await activitiesDef.toDtos([row.row], { user, conn: db });
  if (done)
    await emitRecordEvent(activitiesDef, 'completed', dto as unknown as Record<string, unknown>, user);
  if (row.spawned) {
    const [next] = await activitiesDef.toDtos([row.spawned], { user, conn: db });
    await emitRecordEvent(activitiesDef, 'created', next as unknown as Record<string, unknown>, user);
  }
  return dto!;
}

export const activitiesRoutes = [
  // Static `/comments/:uuid` paths before `/:uuid`.
  activityCommentRoutes,
  checklistRoutes,
  defineRoutes('/activities', ['activities'])
    .add({
      method: 'get',
      path: '/board',
      permission: 'core.activities.view',
      summary: 'Tasks grouped by status for the board (task statuses feature)',
      query: boardQuerySchema,
      handler: async ({ user, query }) => {
        await assertTaskPipeline();
        return loadBoard(activitiesDef, 'activity', user, query);
      },
    })
    .add({
      method: 'patch',
      path: '/:uuid/stage',
      permission: 'core.activities.update',
      params: uuidParam,
      body: dealMoveSchema,
      summary: 'Move a task to a status (and position within it); the done status completes it',
      handler: async ({ ctx, user, params, body }): Promise<ActivityDto> => {
        await assertTaskPipeline();
        let spawned: Record<string, unknown> | null = null;
        let completedNow = false;
        const updated = await moveToStage(
          activitiesDef,
          'activity',
          ctx,
          user,
          params.uuid,
          body,
          async (stage, trx) => {
            const row = await trx('activities').where({ uuid: params.uuid }).first('id', 'completed_at');
            if (stage.is_won && !row.completed_at) {
              completedNow = true;
              spawned = await spawnNextOccurrence(trx, ctx, row.id as number);
              return { completed_at: new Date() };
            }
            return stage.is_won ? {} : { completed_at: null };
          },
        );
        const [dto] = await activitiesDef.toDtos([updated.row], { user, conn: db });
        const payload = dto as unknown as Record<string, unknown>;
        if (updated.stageChange)
          await emitRecordEvent(
            activitiesDef,
            'updated',
            payload,
            user,
            await publicStageChanges(db, { stage_id: updated.stageChange }),
          );
        if (completedNow) await emitRecordEvent(activitiesDef, 'completed', payload, user);
        if (spawned) {
          const [next] = await activitiesDef.toDtos([spawned], { user, conn: db });
          await emitRecordEvent(activitiesDef, 'created', next as unknown as Record<string, unknown>, user);
        }
        return dto!;
      },
    })
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
