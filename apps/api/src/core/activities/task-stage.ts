import type { Db } from '../../db/knex';
import { getGroup } from '../settings/settings.service';
import { endOfStage, resolveStage, type StageRow } from '../pipelines/stage-engine';
import { STAGED_ACTIVITY_TYPES } from '../pipelines/task-pipeline';

type Row = Record<string, unknown>;

/**
 * The stage a task should sit on after it is completed or reopened: the done (won) stage when
 * completed; the first open stage when reopened from the done stage; otherwise it stays put.
 */
export async function stageForCompletion(
  conn: Db,
  pipelineId: number,
  done: boolean,
  currentStageId: number | null,
): Promise<StageRow | null> {
  const stages = (await conn('pipeline_stages')
    .where({ pipeline_id: pipelineId, active: true })
    .orderBy('sort_order')) as StageRow[];
  const current = stages.find((s) => s.id === currentStageId);
  if (done) {
    const won = stages.find((s) => s.is_won);
    return won && won.id !== currentStageId ? won : null;
  }
  if (current && !current.is_won) return null;
  return stages.find((s) => !s.is_won && !s.is_lost) ?? null;
}

const moveTo = async (conn: Db, stage: StageRow) => ({
  stage_id: stage.id,
  stage_entered_at: new Date(),
  position: await endOfStage(conn, 'activity', stage.id),
});

/**
 * Stage columns for an activity write while task statuses are on. A chosen stage drives
 * completion (done stage = completed); completing or reopening moves the task to match. So
 * `completed_at` and the stage never disagree.
 */
export async function taskStageColumns(conn: Db, input: Row, row: Row, existing?: Row): Promise<Row> {
  const type = (row.type ?? existing?.type) as string;
  if (!(STAGED_ACTIVITY_TYPES as readonly string[]).includes(type)) return {};
  if (!(await getGroup('features', conn)).taskPipeline) return {};
  const out: Row = {};
  const explicit = !!(input.pipelineUuid || input.stageUuid);
  const wasDone = !!existing?.completed_at;
  if (!existing || explicit || !existing.pipeline_id) {
    const placed = await resolveStage(
      conn,
      'activity',
      input.pipelineUuid as string | undefined,
      input.stageUuid as string | undefined,
      existing,
      !explicit,
    );
    if (!placed) return out;
    let stage = placed.stage;
    out.pipeline_id = placed.pipelineId;
    if (explicit) {
      // The chosen stage decides: done stage completes, any other reopens.
      if (stage.is_won && !wasDone) out.completed_at = new Date();
      if (!stage.is_won && wasDone && input.completed !== true) out.completed_at = null;
    } else if (input.completed === true || row.completed_at) {
      // Created or logged as already done (notes never get here): start on the done stage.
      stage = (await stageForCompletion(conn, placed.pipelineId, true, null)) ?? stage;
    }
    if (!existing || existing.stage_id !== stage.id) Object.assign(out, await moveTo(conn, stage));
    return out;
  }
  if (input.completed !== undefined && !!input.completed !== wasDone) {
    const stage = await stageForCompletion(
      conn,
      existing.pipeline_id as number,
      !!input.completed,
      (existing.stage_id as number | null) ?? null,
    );
    if (stage) Object.assign(out, await moveTo(conn, stage));
  }
  return out;
}
