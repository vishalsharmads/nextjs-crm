import { z } from 'zod';
import { listQuerySchema } from '@app/shared';
import { defineRoutes, type RouteGroup } from '../../http/routes';
import type { ResourceDef } from './types';
import { recordBasePath } from './paths';
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
import {
  addRecordComment,
  deleteRecordComment,
  editRecordComment,
  listRecordComments,
} from '../comments/comments';
import { listShares, shareRecord, unshareRecord } from '../sharing/sharing';

export const uuidParam = z.object({ uuid: z.uuid() });

/** Standard REST endpoints for a record entity. Entity-specific routes are added by the caller. */
export const commentParam = uuidParam.extend({ commentUuid: z.uuid() });

/**
 * Comments on a record. Anyone who can see the record may read and add comments (plan D1);
 * authors (and admins) edit and delete their own. Tasks keep their own comment routes.
 */
export function addCommentRoutes(group: RouteGroup, def: ResourceDef): RouteGroup {
  if (def.entity === 'activity') return group;
  const view = `${def.resource}.view`;
  return group
    .add({
      method: 'get',
      path: '/:uuid/comments',
      permission: view,
      params: uuidParam,
      summary: `Comments on one ${def.entity} record`,
      handler: async ({ ctx, user, params }) => ({
        data: await listRecordComments(def, ctx, user, params.uuid),
      }),
    })
    .add({
      method: 'post',
      path: '/:uuid/comments',
      permission: view,
      params: uuidParam,
      body: z.record(z.string(), z.unknown()),
      status: 201,
      handler: ({ ctx, user, params, body }) => addRecordComment(def, ctx, user, params.uuid, body),
    })
    .add({
      method: 'patch',
      path: '/:uuid/comments/:commentUuid',
      permission: view,
      params: commentParam,
      body: z.record(z.string(), z.unknown()),
      handler: ({ ctx, user, params, body }) =>
        editRecordComment(def, ctx, user, params.uuid, params.commentUuid, body),
    })
    .add({
      method: 'delete',
      path: '/:uuid/comments/:commentUuid',
      permission: view,
      params: commentParam,
      status: 204,
      handler: ({ ctx, user, params }) =>
        deleteRecordComment(def, ctx, user, params.uuid, params.commentUuid),
    });
}

const shareParam = uuidParam.extend({ shareUuid: z.uuid() });

/** Sharing one record with a person or team. Tasks are shared through what they belong to. */
export function addShareRoutes(group: RouteGroup, def: ResourceDef): RouteGroup {
  if (def.entity === 'activity') return group;
  const view = `${def.resource}.view`;
  return group
    .add({
      method: 'get',
      path: '/:uuid/shares',
      permission: view,
      params: uuidParam,
      summary: `Who one ${def.entity} record is shared with`,
      handler: ({ user, params }) => listShares(def, user, params.uuid),
    })
    .add({
      method: 'post',
      path: '/:uuid/shares',
      permission: view,
      params: uuidParam,
      body: z.record(z.string(), z.unknown()),
      status: 201,
      handler: ({ ctx, user, params, body }) => shareRecord(def, ctx, user, params.uuid, body),
    })
    .add({
      method: 'delete',
      path: '/:uuid/shares/:shareUuid',
      permission: view,
      params: shareParam,
      status: 204,
      handler: ({ ctx, user, params }) => unshareRecord(def, ctx, user, params.uuid, params.shareUuid),
    });
}

export function recordRoutes(def: ResourceDef, tag: string): RouteGroup {
  const p = (action: string) => `${def.resource}.${action}`;
  const group = defineRoutes(recordBasePath(def), [tag], def.moduleKey)
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
      handler: async ({ ctx, user, params, query }) => {
        assertCan(user, p('view'));
        const row = await getRow(def, user, params.uuid);
        return recordTimeline(def.entity, row, user, query, ctx);
      },
    });
  return addShareRoutes(addCommentRoutes(group, def), def);
}
