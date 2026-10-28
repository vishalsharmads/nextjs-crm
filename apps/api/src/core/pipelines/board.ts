import { z } from 'zod';
import { filterParamSchema, type dealMoveSchema } from '@app/shared';
import { db } from '../../db/knex';
import { notFound, AppError } from '../../lib/errors';
import type { AuthUser, RequestContext } from '../../http/context';
import { audit } from '../audit/audit.service';
import { applyScope } from '../rbac/access';
import { applyListCriteria, getRow } from '../records/service';
import type { ResourceDef } from '../records/types';
import {
  STAGED,
  defaultPipeline,
  positionBetween,
  recordStageHistory,
  stageRef,
  type StageRow,
  type StagedEntity,
} from './stage-engine';

const BOARD_LIMIT_PER_STAGE = 200;

export const boardQuerySchema = z.object({
  pipeline: z.uuid().optional(),
  filter: filterParamSchema.optional(),
  q: z.string().max(200).optional(),
  view: z.uuid().optional(),
});

type Row = Record<string, unknown> & { id: number };

/**
 * Records grouped by stage for a Kanban board, scoped and filtered like the list. `sumColumn` adds a per-stage
 * total (deal value); each column holds at most 200 records, with the full count alongside.
 */
export async function loadBoard<D extends { stage: { uuid?: string } | null }>(
  def: ResourceDef<Row, D>,
  entity: StagedEntity,
  user: AuthUser,
  query: z.infer<typeof boardQuerySchema>,
  sumColumn?: string,
) {
  const { table } = STAGED[entity];
  const pipeline = query.pipeline
    ? await db('pipelines').where({ uuid: query.pipeline, entity }).first()
    : await defaultPipeline(db, entity);
  if (!pipeline) throw notFound('Pipeline');
  const stages = (await db('pipeline_stages')
    .where({ pipeline_id: pipeline.id, active: true })
    .orderBy('sort_order')) as StageRow[];
  const qb = db(table).whereNull(`${table}.deleted_at`).where(`${table}.pipeline_id`, pipeline.id);
  await applyScope(qb, user, def.resource, def.ownerColumns);
  await applyListCriteria(qb, def, user, query);
  const totalsQb = qb.clone().groupBy(`${table}.stage_id`).select(`${table}.stage_id`).count({ n: '*' });
  if (sumColumn) totalsQb.sum({ v: `${table}.${sumColumn}` });
  const totals = (await totalsQb) as { stage_id: number; n: number; v?: number }[];
  const rows = await qb
    .clone()
    .select(`${table}.*`)
    .orderBy(`${table}.position`)
    .orderBy(`${table}.id`)
    .limit(BOARD_LIMIT_PER_STAGE * Math.max(stages.length, 1));
  const dtos = await def.toDtos(rows, { user, conn: db });
  return {
    pipeline: { uuid: pipeline.uuid as string, name: pipeline.name as string },
    columns: stages.map((s) => {
      const t = totals.find((x) => x.stage_id === s.id);
      return {
        stage: stageRef(s),
        count: Number(t?.n ?? 0),
        total: Number(t?.v ?? 0),
        records: dtos.filter((d) => d.stage?.uuid === s.uuid).slice(0, BOARD_LIMIT_PER_STAGE),
      };
    }),
  };
}

/**
 * Move a record to a stage (and a place in its column). The caller adds entity-specific columns for a stage
 * change through `onStageChange` (deal status, won/lost dates). Returns the updated row and the change.
 */
export async function moveToStage(
  def: ResourceDef,
  entity: StagedEntity,
  ctx: RequestContext,
  user: AuthUser,
  uuid: string,
  body: z.infer<typeof dealMoveSchema>,
  onStageChange?: (stage: StageRow, trx: typeof db) => Promise<Record<string, unknown>>,
) {
  const { table } = STAGED[entity];
  return db.transaction(async (trx) => {
    const record = await getRow(def, user, uuid, trx, { forUpdate: true });
    if (!record.pipeline_id) throw new AppError('STAGE_INVALID', 'This record is not on a pipeline');
    const stage = (await trx('pipeline_stages')
      .where({ uuid: body.stageUuid, pipeline_id: record.pipeline_id, active: true })
      .first()) as StageRow | undefined;
    if (!stage) throw new AppError('STAGE_INVALID', 'That stage is not part of this pipeline');
    const position = await positionBetween(trx, entity, stage.id, body.beforeUuid, body.afterUuid);
    const patch: Record<string, unknown> = { position, updated_by: user.id };
    const stageChanged = stage.id !== record.stage_id;
    if (stageChanged) {
      Object.assign(patch, { stage_id: stage.id, stage_entered_at: new Date() });
      if (onStageChange) Object.assign(patch, await onStageChange(stage, trx));
    }
    await trx(table).where({ id: record.id }).update(patch);
    if (stageChanged) {
      const from = (record.stage_id as number | null) ?? null;
      await recordStageHistory(trx, entity, [record.id as number], from, stage.id, user.id);
      await audit(trx, ctx, {
        action: `${entity}.stage_changed`,
        entity,
        entityId: record.id as number,
        entityUuid: uuid,
        diff: {
          stage: { from, to: stage.id },
          ...(body.lostReason && patch.lost_reason
            ? { lost_reason: { from: null, to: body.lostReason } }
            : {}),
        },
      });
    }
    return {
      row: (await trx(table).where({ id: record.id }).first()) as Row,
      stageChange: stageChanged ? { from: (record.stage_id as number | null) ?? null, to: stage.id } : null,
    };
  });
}
