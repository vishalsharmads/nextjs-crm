import type { PipelineDto, StageDto } from '@app/shared';
import { db, type Db } from '../../db/knex';

export const stageDto = (s: Record<string, unknown>): StageDto => ({
  uuid: s.uuid as string,
  key: s.key as string,
  name: s.name as string,
  color: (s.color as string | null) ?? null,
  probability: Number(s.probability),
  sortOrder: Number(s.sort_order),
  isWon: !!s.is_won,
  isLost: !!s.is_lost,
  rottingDays: (s.rotting_days as number | null) ?? null,
});

export async function listPipelines(
  conn: Db = db,
  opts: { includeInactive?: boolean } = {},
): Promise<PipelineDto[]> {
  const q = conn('pipelines').orderBy([{ column: 'sort_order' }, { column: 'id' }]);
  if (!opts.includeInactive) q.where({ active: true });
  const pipelines = await q;
  if (!pipelines.length) return [];
  const stages = await conn('pipeline_stages')
    .whereIn(
      'pipeline_id',
      pipelines.map((p) => p.id),
    )
    .where({ active: true })
    .orderBy([{ column: 'sort_order' }, { column: 'id' }]);
  return pipelines.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    entity: p.entity,
    isDefault: !!p.is_default,
    sortOrder: p.sort_order,
    sourceBlueprint: p.source_blueprint,
    customized: !!p.customized,
    stages: stages.filter((s) => s.pipeline_id === p.id).map(stageDto),
  }));
}
