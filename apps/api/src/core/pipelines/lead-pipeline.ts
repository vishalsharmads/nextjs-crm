import type { Db } from '../../db/knex';
import type { RequestContext } from '../../http/context';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { defaultPipeline } from './stage-engine';

const STARTER_STAGES = [
  { key: 'new', name: 'New', color: 'blue', is_won: false, is_lost: false, rotting_days: 7 },
  { key: 'contacted', name: 'Contacted', color: 'teal', is_won: false, is_lost: false, rotting_days: 14 },
  { key: 'qualified', name: 'Qualified', color: 'green', is_won: true, is_lost: false, rotting_days: null },
  { key: 'unqualified', name: 'Unqualified', color: 'red', is_won: false, is_lost: true, rotting_days: null },
];

/**
 * Turning the lead pipeline on: create a starter pipeline when none exists (a blueprint may already have
 * seeded one), then place every lead without a stage on it. Converted leads land on the won stage and
 * unqualified ones on the lost stage, so the board starts out matching each lead's status.
 */
export async function enableLeadPipeline(conn: Db, ctx: RequestContext) {
  let pipeline = await defaultPipeline(conn, 'lead');
  if (!pipeline) {
    const uuid = newUuid();
    const [id] = await conn('pipelines').insert({
      uuid,
      name: 'Leads',
      entity: 'lead',
      is_default: true,
      sort_order: 10,
      customized: true,
    });
    await conn('pipeline_stages').insert(
      STARTER_STAGES.map((s, i) => ({
        ...s,
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
      diff: { entity: 'lead', reason: 'lead pipeline enabled' },
    });
    pipeline = await conn('pipelines').where({ id }).first();
  }
  const stages = await conn('pipeline_stages')
    .where({ pipeline_id: pipeline.id, active: true })
    .orderBy('sort_order');
  const open = stages.find((s) => !s.is_won && !s.is_lost);
  const won = stages.find((s) => s.is_won) ?? open;
  const lost = stages.find((s) => s.is_lost) ?? open;
  if (!open) return;
  const now = new Date();
  const place = (stageId: number, statuses: string[] | null) => {
    const qb = conn('leads').whereNull('stage_id');
    if (statuses) qb.whereIn('status', statuses);
    // Positions follow creation order; the board sorts by position then id.
    return qb.update({ pipeline_id: pipeline.id, stage_id: stageId, stage_entered_at: now, position: 1000 });
  };
  await place(won.id, ['converted']);
  await place(lost.id, ['unqualified']);
  await place(open.id, null);
}
