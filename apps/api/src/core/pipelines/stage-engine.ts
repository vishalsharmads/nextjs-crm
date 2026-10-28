import type { Db } from '../../db/knex';
import { AppError } from '../../lib/errors';

/** Records that move through pipeline stages. Each has a history table with `<entity>_id`. */
export type StagedEntity = 'deal' | 'lead';

export const STAGED: Record<StagedEntity, { table: string; history: string; fk: string }> = {
  deal: { table: 'deals', history: 'deal_stage_history', fk: 'deal_id' },
  lead: { table: 'leads', history: 'lead_stage_history', fk: 'lead_id' },
};

type Row = Record<string, unknown>;
export type StageRow = Row & { id: number; is_won: number | boolean; is_lost: number | boolean };

export async function defaultPipeline(conn: Db, entity: StagedEntity) {
  return (
    (await conn('pipelines').where({ entity, active: true, is_default: true }).first()) ??
    (await conn('pipelines').where({ entity, active: true }).orderBy('sort_order').first())
  );
}

/**
 * Resolve pipeline + stage for a write; the stage must belong to the pipeline. Without a stage, a record keeps
 * its current one (same pipeline) or starts on the first open stage. Returns null when the entity has no
 * pipeline and `optional` is set (leads: the feature can be on before an admin creates a lead pipeline).
 */
export async function resolveStage(
  conn: Db,
  entity: StagedEntity,
  pipelineUuid?: string,
  stageUuid?: string,
  existing?: Row,
  optional = false,
): Promise<{ pipelineId: number; stage: StageRow } | null> {
  let pipelineId = (existing?.pipeline_id as number | null | undefined) ?? undefined;
  if (pipelineUuid) {
    const p = await conn('pipelines').where({ uuid: pipelineUuid, entity, active: true }).first('id');
    if (!p)
      throw new AppError('VALIDATION_FAILED', 'Unknown pipeline', [
        { path: 'pipelineUuid', message: 'Unknown pipeline' },
      ]);
    pipelineId = p.id;
  }
  if (!pipelineId) {
    const p = await defaultPipeline(conn, entity);
    if (!p) {
      if (optional) return null;
      throw new AppError('VALIDATION_FAILED', 'Create a pipeline first');
    }
    pipelineId = p.id as number;
  }
  let stage: StageRow | undefined;
  if (stageUuid) {
    stage = await conn('pipeline_stages')
      .where({ uuid: stageUuid, pipeline_id: pipelineId, active: true })
      .first();
    if (!stage) throw new AppError('STAGE_INVALID', 'That stage is not part of this pipeline');
  } else if (existing?.stage_id && existing.pipeline_id === pipelineId) {
    stage = await conn('pipeline_stages').where({ id: existing.stage_id }).first();
  } else {
    stage = await conn('pipeline_stages')
      .where({ pipeline_id: pipelineId, active: true, is_won: false, is_lost: false })
      .orderBy('sort_order')
      .first();
    if (!stage) throw new AppError('STAGE_INVALID', 'This pipeline has no open stages');
  }
  return { pipelineId: pipelineId!, stage: stage! };
}

/** The position at the end of a stage's column. */
export async function endOfStage(conn: Db, entity: StagedEntity, stageId: number): Promise<number> {
  const max = await conn(STAGED[entity].table)
    .where({ stage_id: stageId })
    .whereNull('deleted_at')
    .max({ m: 'position' })
    .first();
  return Number((max as { m: number | null } | undefined)?.m ?? 0) + 1000;
}

/** A position between the given neighbours in the target stage, or the end of the column. */
export async function positionBetween(
  conn: Db,
  entity: StagedEntity,
  stageId: number,
  beforeUuid?: string | null,
  afterUuid?: string | null,
): Promise<number> {
  const neighbour = async (uuid: string | null | undefined) =>
    uuid
      ? ((
          await conn(STAGED[entity].table)
            .where({ uuid, stage_id: stageId })
            .whereNull('deleted_at')
            .first('position')
        )?.position as number | undefined)
      : undefined;
  const before = await neighbour(beforeUuid);
  const after = await neighbour(afterUuid);
  if (before != null && after != null) return (Number(before) + Number(after)) / 2;
  if (after != null) return Number(after) - 1000;
  if (before != null) return Number(before) + 1000;
  return endOfStage(conn, entity, stageId);
}

export async function recordStageHistory(
  conn: Db,
  entity: StagedEntity,
  ids: number[],
  from: number | null,
  to: number,
  userId: number,
) {
  if (!ids.length) return;
  const { history, fk } = STAGED[entity];
  await conn(history).insert(
    ids.map((id) => ({ [fk]: id, from_stage_id: from, to_stage_id: to, changed_by: userId })),
  );
}

export function stageRef(s: StageRow) {
  return {
    uuid: s.uuid as string,
    key: s.key as string,
    name: s.name as string,
    color: (s.color as string | null) ?? null,
    probability: Number(s.probability ?? 0),
    isWon: !!s.is_won,
    isLost: !!s.is_lost,
    rottingDays: (s.rotting_days as number | null) ?? null,
  };
}

/** Whether a record has sat in an open stage longer than the stage allows. */
export function isRotting(stage: StageRow | undefined, enteredAt: unknown): boolean {
  if (!stage?.rotting_days || stage.is_won || stage.is_lost || !enteredAt) return false;
  return Date.now() - new Date(enteredAt as string).getTime() > Number(stage.rotting_days) * 86_400_000;
}
