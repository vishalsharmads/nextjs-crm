import { z } from 'zod';
import { duplicateRuleSchema, toPatch, type DuplicateEntity } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { getDefinitions } from '../custom-fields/definitions';
import { dismissPair, listPairs, ruleDto, scanDuplicates } from './duplicates';

const uuidParam = z.object({ uuid: z.uuid() });

/** A `cf:` field must be a filterable custom field (it has an indexed column) and not special-category. */
async function assertFields(entity: DuplicateEntity, fields: string[]) {
  const custom = fields.filter((f) => f.startsWith('cf:')).map((f) => f.slice(3));
  if (!custom.length) return;
  const defs = await getDefinitions(entity);
  for (const key of custom) {
    const d = defs.find((x) => x.key === key);
    if (!d || !d.filterable || d.sensitivity === 'special')
      throw new AppError('VALIDATION_FAILED', 'Choose filterable custom fields that are not sensitive', [
        { path: 'fields', message: `${key} cannot be compared` },
      ]);
  }
}

export const duplicateRoutes = defineRoutes('/duplicates', ['duplicates'])
  .add({
    method: 'get',
    path: '/rules',
    permission: 'core.settings.manage',
    handler: async () => ({
      data: (await db('duplicate_rules').orderBy(['entity', 'position', 'id'])).map(ruleDto),
    }),
  })
  .add({
    method: 'post',
    path: '/rules',
    permission: 'core.settings.manage',
    body: duplicateRuleSchema,
    status: 201,
    handler: async ({ ctx, body }) => {
      await assertFields(body.entity, body.fields);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const max = await trx('duplicate_rules')
          .where({ entity: body.entity })
          .max({ p: 'position' })
          .first();
        const [id] = await trx('duplicate_rules').insert({
          uuid,
          ...body,
          fields: JSON.stringify(body.fields),
          position: Number(max?.p ?? 0) + 1,
          customized: true,
        });
        await audit(trx, ctx, {
          action: 'duplicate_rule.created',
          entity: 'duplicate_rule',
          entityId: id,
          entityUuid: uuid,
          diff: body,
        });
      });
      return ruleDto(await db('duplicate_rules').where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/rules/:uuid',
    permission: 'core.settings.manage',
    params: uuidParam,
    body: toPatch(duplicateRuleSchema.omit({ entity: true })),
    handler: async ({ ctx, params, body }) => {
      const rule = await db('duplicate_rules').where({ uuid: params.uuid }).first();
      if (!rule) throw notFound('Rule');
      if (body.fields) await assertFields(rule.entity, body.fields);
      await db.transaction(async (trx) => {
        await trx('duplicate_rules')
          .where({ id: rule.id })
          .update({
            ...body,
            ...(body.fields ? { fields: JSON.stringify(body.fields) } : {}),
            customized: true,
          });
        await audit(trx, ctx, {
          action: 'duplicate_rule.updated',
          entity: 'duplicate_rule',
          entityId: rule.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return ruleDto(await db('duplicate_rules').where({ id: rule.id }).first());
    },
  })
  .add({
    method: 'delete',
    path: '/rules/:uuid',
    permission: 'core.settings.manage',
    params: uuidParam,
    status: 204,
    handler: async ({ ctx, params }) => {
      await db.transaction(async (trx) => {
        const n = await trx('duplicate_rules').where({ uuid: params.uuid }).delete();
        if (!n) throw notFound('Rule');
        await audit(trx, ctx, {
          action: 'duplicate_rule.deleted',
          entity: 'duplicate_rule',
          entityUuid: params.uuid,
        });
      });
    },
  })
  .add({
    method: 'post',
    path: '/scan',
    permission: 'core.settings.manage',
    summary: 'Look for duplicate contacts and organizations now (also runs nightly)',
    handler: async ({ ctx }) => {
      const result = await scanDuplicates();
      await audit(db, ctx, { action: 'duplicates.scanned', entity: 'duplicate_rule', diff: result });
      return result;
    },
  })
  .add({
    method: 'get',
    path: '/pairs',
    permission: 'authenticated',
    summary: 'Possible duplicates waiting for a decision (records you may merge and can see)',
    query: z.object({ entity: z.enum(['contact', 'organization']).optional() }),
    handler: async ({ user, query }) => ({ data: await listPairs(user, query.entity) }),
  })
  .add({
    method: 'post',
    path: '/pairs/:uuid/dismiss',
    permission: 'authenticated',
    params: uuidParam,
    status: 204,
    handler: async ({ ctx, user, params }) => {
      const pair = await dismissPair(user, params.uuid);
      await audit(db, ctx, {
        action: 'duplicates.dismissed',
        entity: pair.entity,
        diff: { pair: params.uuid },
      });
    },
  });
