import type { Db } from '../../db/knex';
import type { RequestContext } from '../../http/context';
import { AppError } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { defaultPipeline } from './stage-engine';

/** Activity types that carry a status; notes and logged emails never do. */
export const STAGED_ACTIVITY_TYPES = ['task', 'call', 'meeting'] as const;

const STARTER_STAGES = [
  { key: 'todo', name: 'To do', color: 'gray', is_won: false },
  { key: 'in_progress', name: 'In progress', color: 'blue', is_won: false },
  { key: 'waiting', name: 'Waiting', color: 'amber', is_won: false },
  { key: 'done', name: 'Done', color: 'green', is_won: true },
];

/**
 * Turning task statuses on: create a starter pipeline when none exists, then place every task,
 * call and meeting without a stage on it: completed ones on the done stage, the rest on the first
 * open stage.
 */
export async function enableTaskPipeline(conn: Db, ctx: RequestContext) {
  let pipeline = await defaultPipeline(conn, 'activity');
  if (!pipeline) {
    const uuid = newUuid();
    const [id] = await conn('pipelines').insert({
      uuid,
      name: 'Task statuses',
      entity: 'activity',
      is_default: true,
      sort_order: 10,
      customized: true,
    });
    await conn('pipeline_stages').insert(
      STARTER_STAGES.map((s, i) => ({
        ...s,
        is_lost: false,
        rotting_days: null,
        uuid: newUuid(),
        pipeline_id: id,
        probability: 0,
        sort_order: (i + 1) * 10,
        customized: true,
      })),
    );
    await audit(conn, ctx, {
      action: 'pipeline.created',
      entity: 'pipeline',
      entityId: id,
      entityUuid: uuid,
      diff: { entity: 'activity', reason: 'task statuses enabled' },
    });
    pipeline = await conn('pipelines').where({ id }).first();
  }
  const stages = await conn('pipeline_stages')
    .where({ pipeline_id: pipeline.id, active: true })
    .orderBy('sort_order');
  const open = stages.find((s) => !s.is_won && !s.is_lost);
  const done = stages.find((s) => s.is_won);
  if (!open || !done)
    throw new AppError('VALIDATION_FAILED', 'The task pipeline needs an open stage and a done stage');
  const now = new Date();
  const userId = ctx.user?.id ?? null;
  const place = async (stageId: number, completed: boolean) => {
    const qb = conn('activities')
      .whereNull('stage_id')
      .whereNull('deleted_at')
      .whereIn('type', STAGED_ACTIVITY_TYPES);
    if (completed) qb.whereNotNull('completed_at');
    else qb.whereNull('completed_at');
    const ids = (await qb.pluck('id')) as number[];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await conn('activities')
        .whereIn('id', chunk)
        .update({ pipeline_id: pipeline.id, stage_id: stageId, stage_entered_at: now, position: 1000 });
      await conn('activity_stage_history').insert(
        chunk.map((activity_id) => ({
          activity_id,
          from_stage_id: null,
          to_stage_id: stageId,
          changed_by: userId,
        })),
      );
    }
    return ids.length;
  };
  const placed = { open: await place(open.id, false), done: await place(done.id, true) };
  await audit(conn, ctx, {
    action: 'activity.pipeline_backfilled',
    entity: 'pipeline',
    entityId: pipeline.id,
    entityUuid: pipeline.uuid,
    diff: placed,
  });
}
