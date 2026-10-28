import { z } from 'zod';
import {
  CUSTOM_OBJECTS_KEY,
  MAX_CUSTOM_OBJECTS,
  customObjectInputSchema,
  customObjectPatchSchema,
  listQuerySchema,
  objectRoute,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, conflict, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { allModuleRecordDefs, findRecordDef } from '../records/registry';
import type { ResourceDef } from '../records/types';
import {
  createRecord,
  deleteRecord,
  getRecord,
  getRow,
  listRecords,
  restoreRecord,
  updateRecord,
} from '../records/service';
import { recordTimeline } from '../timeline/timeline.service';
import { runBulk } from '../bulk/bulk.service';
import { exportCsv, exportQuerySchema } from '../imports/import-export';
import { assertCan } from '../rbac/access';
import { clearLabelCache } from '../labels/labels.service';
import {
  ensureObjectTable,
  loadCustomObjects,
  objectKeyProblem,
  toObjectDto,
  type ObjectRow,
} from './objects';

const uuidParam = z.object({ uuid: z.uuid() });

async function findObject(uuid: string): Promise<ObjectRow> {
  const row = (await db('custom_objects').where({ uuid }).first()) as ObjectRow | undefined;
  if (!row) throw notFound('Object');
  return row;
}

/** Reload objects into the registry, permissions and vocabulary after a change. */
async function reload() {
  await loadCustomObjects();
  clearLabelCache();
}

/** Settings → Objects. Admin-defined record types (amended non-negotiable #5). */
export const objectsRoutes = defineRoutes('/objects', ['objects'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.fields.manage',
    handler: async () => {
      const rows = (await db('custom_objects').orderBy('sort_order').orderBy('id')) as ObjectRow[];
      return { data: rows.map(toObjectDto) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.fields.manage',
    body: customObjectInputSchema,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      const key = body.key;
      const problem = await objectKeyProblem(key);
      if (problem) throw conflict('That key is already in use', [{ path: 'key', message: problem }]);
      const { n } = (await db('custom_objects').count({ n: '*' }).first()) as { n: number };
      if (Number(n) >= MAX_CUSTOM_OBJECTS)
        throw new AppError('VALIDATION_FAILED', `You can have at most ${MAX_CUSTOM_OBJECTS} objects`);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('custom_objects').insert({
          uuid,
          entity: key,
          route: objectRoute(key),
          singular: body.singular,
          plural: body.plural,
          icon: body.icon,
          description: body.description ?? null,
          links: JSON.stringify(body.links),
          sort_order: Number(n) * 10,
          customized: true,
          created_by: user.id,
          updated_by: user.id,
        });
        await audit(trx, ctx, {
          action: 'object.created',
          entity: 'custom_object',
          entityId: id,
          entityUuid: uuid,
          diff: body,
        });
      });
      // DDL runs after the transaction: MySQL commits implicitly on CREATE and ALTER TABLE.
      const row = await findObject(uuid);
      await ensureObjectTable(row);
      await reload();
      return toObjectDto(row);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.fields.manage',
    params: uuidParam,
    body: customObjectPatchSchema,
    handler: async ({ ctx, user, params, body }) => {
      const row = await findObject(params.uuid);
      const current = toObjectDto(row);
      if (body.links && current.links.some((l) => !body.links!.includes(l)))
        throw new AppError('VALIDATION_FAILED', 'Links can be added but not removed', [
          { path: 'links', message: 'Links can be added but not removed' },
        ]);
      const patch: Record<string, unknown> = { customized: true, updated_by: user.id };
      for (const k of ['singular', 'plural', 'icon', 'description'] as const)
        if (body[k] !== undefined) patch[k] = body[k] ?? null;
      if (body.links) patch.links = JSON.stringify([...new Set(body.links)]);
      await db.transaction(async (trx) => {
        await trx('custom_objects').where({ id: row.id }).update(patch);
        await audit(trx, ctx, {
          action: 'object.updated',
          entity: 'custom_object',
          entityId: row.id,
          entityUuid: row.uuid,
          diff: body,
        });
      });
      const updated = await findObject(params.uuid);
      await ensureObjectTable(updated);
      await reload();
      return toObjectDto(updated);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/archive',
    permission: 'core.fields.manage',
    params: uuidParam,
    handler: ({ ctx, user, params }) => setArchived(ctx, user.id, params.uuid, true),
  })
  .add({
    method: 'post',
    path: '/:uuid/restore',
    permission: 'core.fields.manage',
    params: uuidParam,
    handler: ({ ctx, user, params }) => setArchived(ctx, user.id, params.uuid, false),
  });

/** Archiving hides an object and its records; nothing is dropped, and restoring brings it back. */
async function setArchived(
  ctx: Parameters<typeof audit>[1],
  userId: number,
  uuid: string,
  archived: boolean,
) {
  const row = await findObject(uuid);
  await db.transaction(async (trx) => {
    await trx('custom_objects')
      .where({ id: row.id })
      .update({ archived_at: archived ? new Date() : null, customized: true, updated_by: userId });
    await audit(trx, ctx, {
      action: archived ? 'object.archived' : 'object.restored',
      entity: 'custom_object',
      entityId: row.id,
      entityUuid: row.uuid,
    });
  });
  await reload();
  return toObjectDto(await findObject(uuid));
}

/** The record type of an object from its URL segment; archived or unknown objects are 404. */
function objectDef(route: string): ResourceDef {
  const def = allModuleRecordDefs().find((d) => d.moduleKey === CUSTOM_OBJECTS_KEY && d.route === route);
  if (!def || !findRecordDef(def.entity)) throw notFound('Object');
  return def;
}

const objectParam = z.object({ object: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/) });
const recordParam = objectParam.extend({ uuid: z.uuid() });

/**
 * Records of every object, resolved per request so objects created at runtime need no new routes.
 * The permission is per object (`custom.<key>.<action>`), so routes are `authenticated` and the
 * records services check it, exactly as they do for core entities.
 */
export const objectRecordRoutes = defineRoutes('/o/:object', ['objects'])
  .add({
    method: 'post',
    path: '/bulk',
    permission: 'authenticated',
    params: objectParam,
    body: z.record(z.string(), z.unknown()),
    handler: ({ ctx, user, params, body }) => runBulk(objectDef(params.object), ctx, user, body),
  })
  .add({
    method: 'get',
    path: '/export',
    permission: 'authenticated',
    params: objectParam,
    query: exportQuerySchema,
    handler: ({ res, ctx, user, params, query }) =>
      exportCsv(objectDef(params.object), ctx, user, query, res),
  })
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    params: objectParam,
    query: listQuerySchema,
    handler: ({ user, params, query }) => listRecords(objectDef(params.object), user, query),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'authenticated',
    params: objectParam,
    body: z.record(z.string(), z.unknown()),
    status: 201,
    handler: ({ ctx, user, params, body }) => createRecord(objectDef(params.object), ctx, user, body),
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'authenticated',
    params: recordParam,
    handler: ({ ctx, user, params }) => getRecord(objectDef(params.object), user, params.uuid, ctx),
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'authenticated',
    params: recordParam,
    body: z.record(z.string(), z.unknown()),
    handler: ({ ctx, user, params, body }) =>
      updateRecord(objectDef(params.object), ctx, user, params.uuid, body),
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'authenticated',
    params: recordParam,
    handler: ({ ctx, user, params }) => deleteRecord(objectDef(params.object), ctx, user, params.uuid),
  })
  .add({
    method: 'post',
    path: '/:uuid/restore',
    permission: 'authenticated',
    params: recordParam,
    handler: ({ ctx, user, params }) => restoreRecord(objectDef(params.object), ctx, user, params.uuid),
  })
  .add({
    method: 'get',
    path: '/:uuid/timeline',
    permission: 'authenticated',
    params: recordParam,
    query: z.object({
      kinds: z.string().max(200).optional(),
      before: z.iso.datetime().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    handler: async ({ user, params, query }) => {
      const def = objectDef(params.object);
      assertCan(user, `${def.resource}.view`);
      const row = await getRow(def, user, params.uuid);
      return recordTimeline(def.entity, row, user, query);
    },
  });
