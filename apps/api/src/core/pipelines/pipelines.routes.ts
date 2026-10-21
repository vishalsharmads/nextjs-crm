import { toPatch } from '@app/shared';
import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, conflict, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { listPipelines } from './pipelines.repository';

const uuidParam = z.object({ uuid: z.uuid() });
const stageBody = z.object({
  name: z.string().trim().min(1).max(100),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
  color: z.string().max(32).nullish(),
  probability: z.number().int().min(0).max(100).default(0),
  isWon: z.boolean().default(false),
  isLost: z.boolean().default(false),
  rottingDays: z.number().int().min(1).max(3650).nullish(),
});
const pipelineBody = z.object({
  name: z.string().trim().min(1).max(100),
  entity: z.enum(['deal', 'lead']).default('deal'),
  isDefault: z.boolean().default(false),
  stages: z.array(stageBody).min(2).max(30).optional(),
});

const keyFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'stage';

function assertOutcomes(stages: { isWon: boolean; isLost: boolean }[]) {
  if (stages.filter((s) => s.isWon).length > 1 || stages.filter((s) => s.isLost).length > 1) {
    throw new AppError('VALIDATION_FAILED', 'A pipeline can have at most one won stage and one lost stage');
  }
}

async function getPipeline(uuid: string) {
  const all = await listPipelines(db, { includeInactive: true });
  const p = all.find((x) => x.uuid === uuid);
  if (!p) throw notFound('Pipeline');
  return p;
}

export const pipelinesRoutes = defineRoutes('/pipelines', ['pipelines'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    handler: async () => ({ data: await listPipelines() }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.pipelines.manage',
    body: pipelineBody,
    status: 201,
    handler: async ({ ctx, body }) => {
      const stages = body.stages ?? [
        { name: 'New', probability: 10, isWon: false, isLost: false },
        { name: 'In progress', probability: 50, isWon: false, isLost: false },
        { name: 'Won', probability: 100, isWon: true, isLost: false },
        { name: 'Lost', probability: 0, isWon: false, isLost: true },
      ];
      assertOutcomes(stages);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        if (body.isDefault)
          await trx('pipelines').where({ entity: body.entity }).update({ is_default: false });
        const max = await trx('pipelines').max({ m: 'sort_order' }).first();
        const [id] = await trx('pipelines').insert({
          uuid,
          name: body.name,
          entity: body.entity,
          is_default: body.isDefault,
          sort_order: Number((max as { m: number | null })?.m ?? 0) + 10,
          customized: true,
        });
        const keys = new Set<string>();
        for (const [i, s] of stages.entries()) {
          let key = 'key' in s && s.key ? s.key : keyFrom(s.name);
          while (keys.has(key)) key = `${key}_${i}`;
          keys.add(key);
          await trx('pipeline_stages').insert({
            uuid: newUuid(),
            pipeline_id: id,
            key,
            name: s.name,
            color: 'color' in s ? (s.color ?? null) : null,
            probability: s.isWon ? 100 : s.isLost ? 0 : s.probability,
            is_won: s.isWon,
            is_lost: s.isLost,
            rotting_days: 'rottingDays' in s ? (s.rottingDays ?? null) : null,
            sort_order: (i + 1) * 10,
            customized: true,
          });
        }
        await audit(trx, ctx, {
          action: 'pipeline.created',
          entity: 'pipeline',
          entityId: id,
          entityUuid: uuid,
          diff: body,
        });
      });
      return getPipeline(uuid);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.pipelines.manage',
    params: uuidParam,
    body: toPatch(pipelineBody.omit({ stages: true, entity: true })).extend({
      active: z.boolean().optional(),
    }),
    handler: async ({ ctx, params, body }) => {
      const p = await db('pipelines').where({ uuid: params.uuid }).first();
      if (!p) throw notFound('Pipeline');
      await db.transaction(async (trx) => {
        if (body.isDefault) await trx('pipelines').where({ entity: p.entity }).update({ is_default: false });
        const patch: Record<string, unknown> = { customized: true };
        if (body.name !== undefined) patch.name = body.name;
        if (body.isDefault !== undefined) patch.is_default = body.isDefault;
        if (body.active !== undefined) {
          if (!body.active && (p.is_default || body.isDefault))
            throw conflict('Make another pipeline the default first');
          patch.active = body.active;
        }
        await trx('pipelines').where({ id: p.id }).update(patch);
        await audit(trx, ctx, {
          action: 'pipeline.updated',
          entity: 'pipeline',
          entityId: p.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return getPipeline(params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/stages',
    permission: 'core.pipelines.manage',
    params: uuidParam,
    body: stageBody,
    status: 201,
    handler: async ({ ctx, params, body }) => {
      const p = await db('pipelines').where({ uuid: params.uuid }).first();
      if (!p) throw notFound('Pipeline');
      const existing = await db('pipeline_stages').where({ pipeline_id: p.id, active: true });
      assertOutcomes([...existing.map((s) => ({ isWon: !!s.is_won, isLost: !!s.is_lost })), body]);
      let key = body.key ?? keyFrom(body.name);
      const taken = new Set(
        (await db('pipeline_stages').where({ pipeline_id: p.id }).pluck('key')) as string[],
      );
      for (let i = 2; taken.has(key); i++) key = `${keyFrom(body.name)}_${i}`;
      // New open stages go before the won/lost stages.
      const firstOutcome = existing
        .filter((s) => s.is_won || s.is_lost)
        .sort((a, b) => a.sort_order - b.sort_order)[0];
      const lastOpen = existing
        .filter((s) => !s.is_won && !s.is_lost)
        .sort((a, b) => b.sort_order - a.sort_order)[0];
      const sort =
        body.isWon || body.isLost || !firstOutcome
          ? Math.max(0, ...existing.map((s) => s.sort_order)) + 10
          : ((lastOpen?.sort_order ?? 0) + firstOutcome.sort_order) / 2;
      await db.transaction(async (trx) => {
        const [id] = await trx('pipeline_stages').insert({
          uuid: newUuid(),
          pipeline_id: p.id,
          key,
          name: body.name,
          color: body.color ?? null,
          probability: body.isWon ? 100 : body.isLost ? 0 : body.probability,
          is_won: body.isWon,
          is_lost: body.isLost,
          rotting_days: body.rottingDays ?? null,
          sort_order: Math.round(sort),
          customized: true,
        });
        await audit(trx, ctx, {
          action: 'pipeline.stage_created',
          entity: 'pipeline',
          entityId: p.id,
          entityUuid: params.uuid,
          diff: { stage: id, ...body },
        });
      });
      return getPipeline(params.uuid);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid/stages/:stageUuid',
    permission: 'core.pipelines.manage',
    params: z.object({ uuid: z.uuid(), stageUuid: z.uuid() }),
    body: toPatch(stageBody.omit({ key: true })),
    handler: async ({ ctx, params, body }) => {
      const p = await db('pipelines').where({ uuid: params.uuid }).first();
      const s = p
        ? await db('pipeline_stages').where({ uuid: params.stageUuid, pipeline_id: p.id }).first()
        : null;
      if (!p || !s) throw notFound('Stage');
      if (body.isWon !== undefined || body.isLost !== undefined) {
        const others = await db('pipeline_stages')
          .where({ pipeline_id: p.id, active: true })
          .whereNot({ id: s.id });
        assertOutcomes([
          ...others.map((o) => ({ isWon: !!o.is_won, isLost: !!o.is_lost })),
          { isWon: body.isWon ?? !!s.is_won, isLost: body.isLost ?? !!s.is_lost },
        ]);
      }
      const patch: Record<string, unknown> = { customized: true };
      if (body.name !== undefined) patch.name = body.name;
      if (body.color !== undefined) patch.color = body.color;
      if (body.probability !== undefined) patch.probability = body.probability;
      if (body.isWon !== undefined) patch.is_won = body.isWon;
      if (body.isLost !== undefined) patch.is_lost = body.isLost;
      if (body.rottingDays !== undefined) patch.rotting_days = body.rottingDays;
      await db.transaction(async (trx) => {
        await trx('pipeline_stages').where({ id: s.id }).update(patch);
        await audit(trx, ctx, {
          action: 'pipeline.stage_updated',
          entity: 'pipeline',
          entityId: p.id,
          entityUuid: params.uuid,
          diff: { stage: params.stageUuid, ...body },
        });
      });
      return getPipeline(params.uuid);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid/stages/:stageUuid',
    permission: 'core.pipelines.manage',
    params: z.object({ uuid: z.uuid(), stageUuid: z.uuid() }),
    query: z.object({ moveTo: z.uuid().optional() }),
    summary: 'Remove a stage; deals in it move to another stage first',
    handler: async ({ ctx, user, params, query }) => {
      const p = await db('pipelines').where({ uuid: params.uuid }).first();
      const s = p
        ? await db('pipeline_stages')
            .where({ uuid: params.stageUuid, pipeline_id: p.id, active: true })
            .first()
        : null;
      if (!p || !s) throw notFound('Stage');
      const remaining = await db('pipeline_stages')
        .where({ pipeline_id: p.id, active: true })
        .whereNot({ id: s.id })
        .count({ c: '*' })
        .first();
      if (Number((remaining as { c: number }).c) < 2) throw conflict('A pipeline needs at least two stages');
      const dealCount = Number(
        (
          (await db('deals').where({ stage_id: s.id }).whereNull('deleted_at').count({ c: '*' }).first()) as {
            c: number;
          }
        ).c,
      );
      let target = null;
      if (dealCount) {
        if (!query.moveTo)
          throw new AppError(
            'VALIDATION_FAILED',
            `${dealCount} records are in this stage. Choose where to move them.`,
            [{ path: 'moveTo', message: 'Required' }],
          );
        target = await db('pipeline_stages')
          .where({ uuid: query.moveTo, pipeline_id: p.id, active: true })
          .whereNot({ id: s.id })
          .first();
        if (!target) throw new AppError('STAGE_INVALID', 'Choose a stage in the same pipeline');
      }
      await db.transaction(async (trx) => {
        if (target) {
          const ids = (await trx('deals').where({ stage_id: s.id }).pluck('id')) as number[];
          await trx('deals')
            .whereIn('id', ids)
            .update({
              stage_id: target.id,
              stage_entered_at: new Date(),
              status: target.is_won ? 'won' : target.is_lost ? 'lost' : 'open',
            });
          if (ids.length)
            await trx('deal_stage_history').insert(
              ids.map((deal_id) => ({
                deal_id,
                from_stage_id: s.id,
                to_stage_id: target.id,
                changed_by: user.id,
              })),
            );
        }
        // Stages are deactivated, not deleted: history keeps pointing at them.
        await trx('pipeline_stages').where({ id: s.id }).update({ active: false, customized: true });
        await audit(trx, ctx, {
          action: 'pipeline.stage_removed',
          entity: 'pipeline',
          entityId: p.id,
          entityUuid: params.uuid,
          diff: { stage: params.stageUuid, movedTo: query.moveTo ?? null, deals: dealCount },
        });
      });
      return getPipeline(params.uuid);
    },
  })
  .add({
    method: 'put',
    path: '/:uuid/stages/order',
    permission: 'core.pipelines.manage',
    params: uuidParam,
    body: z.object({ stageUuids: z.array(z.uuid()).min(1).max(30) }),
    handler: async ({ ctx, params, body }) => {
      const p = await db('pipelines').where({ uuid: params.uuid }).first();
      if (!p) throw notFound('Pipeline');
      await db.transaction(async (trx) => {
        for (const [i, uuid] of body.stageUuids.entries())
          await trx('pipeline_stages')
            .where({ uuid, pipeline_id: p.id })
            .update({ sort_order: (i + 1) * 10, customized: true });
        await audit(trx, ctx, {
          action: 'pipeline.stages_reordered',
          entity: 'pipeline',
          entityId: p.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return getPipeline(params.uuid);
    },
  });
