import { z } from 'zod';
import { ENTITY_ROUTE, listQuerySchema } from '@app/shared';
import { defineRoutes, type RouteGroup } from '../../http/routes';
import type { ResourceDef } from './types';
import {
  createRecord,
  deleteRecord,
  getRecord,
  getRow,
  listRecords,
  restoreRecord,
  updateRecord,
} from './service';
import { recordTimeline } from '../timeline/timeline.service';
import { assertCan } from '../rbac/access';

export const uuidParam = z.object({ uuid: z.uuid() });

/** Standard REST endpoints for a record entity. Entity-specific routes are added by the caller. */
export function recordRoutes(def: ResourceDef, tag: string): RouteGroup {
  const base = `/${ENTITY_ROUTE[def.entity]}`;
  const p = (action: string) => `${def.resource}.${action}`;
  return defineRoutes(base, [tag])
    .add({
      method: 'get',
      path: '/',
      permission: p('view'),
      query: listQuerySchema,
      summary: `List ${def.entity} records`,
      handler: ({ user, query }) => listRecords(def, user, query),
    })
    .add({
      method: 'post',
      path: '/',
      permission: p('create'),
      body: z.record(z.string(), z.unknown()),
      status: 201,
      handler: ({ ctx, user, body }) => createRecord(def, ctx, user, body),
    })
    .add({
      method: 'get',
      path: '/:uuid',
      permission: p('view'),
      params: uuidParam,
      handler: ({ ctx, user, params }) => getRecord(def, user, params.uuid, ctx),
    })
    .add({
      method: 'patch',
      path: '/:uuid',
      permission: p('update'),
      params: uuidParam,
      body: z.record(z.string(), z.unknown()),
      handler: ({ ctx, user, params, body }) => updateRecord(def, ctx, user, params.uuid, body),
    })
    .add({
      method: 'delete',
      path: '/:uuid',
      permission: p('delete'),
      params: uuidParam,
      handler: ({ ctx, user, params }) => deleteRecord(def, ctx, user, params.uuid),
    })
    .add({
      method: 'post',
      path: '/:uuid/restore',
      permission: p('delete'),
      params: uuidParam,
      handler: ({ ctx, user, params }) => restoreRecord(def, ctx, user, params.uuid),
    })
    .add({
      method: 'get',
      path: '/:uuid/timeline',
      permission: p('view'),
      params: uuidParam,
      query: z.object({
        kinds: z.string().max(200).optional(),
        before: z.iso.datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      handler: async ({ user, params, query }) => {
        assertCan(user, p('view'));
        const row = await getRow(def, user, params.uuid);
        return recordTimeline(def.entity, row, user, query);
      },
    });
}
