import { z } from 'zod';
import {
  checklistItemPatchSchema,
  checklistItemSchema,
  checklistOrderSchema,
  type ChecklistItemDto,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser, RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { getRow } from '../records/service';
import { uuidParam } from '../records/routes';
import { iso, userRefs } from '../records/hydrate';
import { activitiesDef } from './activities.def';

type Row = Record<string, unknown> & { id: number };

const MAX_ITEMS = 200;
const itemParam = z.object({ itemUuid: z.uuid() });

async function toDtos(rows: Row[], conn: Db = db): Promise<ChecklistItemDto[]> {
  const refs = await userRefs(
    rows.map((r) => r.done_by as number | null),
    conn,
  );
  return rows.map((r) => ({
    uuid: r.uuid as string,
    label: r.label as string,
    done: !!r.done_at,
    doneAt: iso(r.done_at),
    doneBy: refs.get(r.done_by as number) ?? null,
  }));
}

const listRows = (activityId: number, conn: Db = db) =>
  conn('activity_checklist_items').where({ activity_id: activityId }).orderBy(['position', 'id']) as Promise<
    Row[]
  >;

/** Copy a checklist to a new task with every item unticked (recurring tasks). */
export async function copyChecklist(fromId: number, toId: number, conn: Db) {
  const items = await listRows(fromId, conn);
  if (items.length)
    await conn('activity_checklist_items').insert(
      items.map((i) => ({
        uuid: newUuid(),
        activity_id: toId,
        label: i.label,
        position: i.position,
      })),
    );
}

/** Resolve an item through its task, so scope applies: out of scope looks like not found. */
async function itemRow(user: AuthUser, itemUuid: string, conn: Db) {
  const row = (await conn('activity_checklist_items').where({ uuid: itemUuid }).first()) as Row | undefined;
  if (!row) throw notFound('Checklist item');
  const parent = await conn('activities').where({ id: row.activity_id }).first('uuid');
  if (!parent) throw notFound('Checklist item');
  const activity = await getRow(activitiesDef, user, parent.uuid as string, conn, { forUpdate: true });
  return { row, activity };
}

async function log(
  conn: Db,
  ctx: RequestContext,
  activity: Row,
  diff: Record<string, { from: unknown; to: unknown }>,
) {
  await audit(conn, ctx, {
    action: 'activity.checklist_changed',
    entity: 'activity',
    entityId: activity.id,
    entityUuid: activity.uuid as string,
    diff,
  });
}

/** Add an item at the end of a task's checklist (also used by tools). */
export async function addChecklistItem(
  ctx: RequestContext,
  user: AuthUser,
  activityUuid: string,
  label: string,
): Promise<ChecklistItemDto> {
  const row = await db.transaction(async (trx) => {
    const activity = await getRow(activitiesDef, user, activityUuid, trx, { forUpdate: true });
    const stats = await trx('activity_checklist_items')
      .where({ activity_id: activity.id })
      .count('* as n')
      .max('position as top')
      .first();
    if (Number(stats?.n ?? 0) >= MAX_ITEMS)
      throw new AppError('VALIDATION_FAILED', `A checklist holds at most ${MAX_ITEMS} items`);
    const [id] = await trx('activity_checklist_items').insert({
      uuid: newUuid(),
      activity_id: activity.id,
      label,
      position: Number(stats?.top ?? -1) + 1,
    });
    await log(trx, ctx, activity, { [`item:${label}`]: { from: null, to: 'added' } });
    return (await trx('activity_checklist_items').where({ id }).first()) as Row;
  });
  return (await toDtos([row]))[0]!;
}

/** A task's checklist, for tools (scope applies through the task). */
export async function listChecklist(user: AuthUser, activityUuid: string): Promise<ChecklistItemDto[]> {
  const activity = await getRow(activitiesDef, user, activityUuid);
  return toDtos(await listRows(activity.id));
}

export const checklistRoutes = defineRoutes('/activities', ['activities'])
  .add({
    method: 'patch',
    path: '/checklist/:itemUuid',
    permission: 'core.activities.update',
    params: itemParam,
    body: checklistItemPatchSchema,
    handler: async ({ ctx, user, params, body }) => {
      const row = await db.transaction(async (trx) => {
        const { row, activity } = await itemRow(user, params.itemUuid, trx);
        const update: Record<string, unknown> = {};
        const diff: Record<string, { from: unknown; to: unknown }> = {};
        if (body.label !== undefined && body.label !== row.label) {
          update.label = body.label;
          diff.label = { from: row.label, to: body.label };
        }
        if (body.done !== undefined && body.done !== !!row.done_at) {
          update.done_at = body.done ? new Date() : null;
          update.done_by = body.done ? user.id : null;
          diff[`item:${row.label as string}`] = { from: !!row.done_at, to: body.done };
        }
        if (Object.keys(update).length) {
          await trx('activity_checklist_items').where({ id: row.id }).update(update);
          await log(trx, ctx, activity, diff);
        }
        return (await trx('activity_checklist_items').where({ id: row.id }).first()) as Row;
      });
      return (await toDtos([row]))[0];
    },
  })
  .add({
    method: 'delete',
    path: '/checklist/:itemUuid',
    permission: 'core.activities.update',
    params: itemParam,
    status: 204,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const { row, activity } = await itemRow(user, params.itemUuid, trx);
        await trx('activity_checklist_items').where({ id: row.id }).delete();
        await log(trx, ctx, activity, { [`item:${row.label as string}`]: { from: 'added', to: null } });
      });
    },
  })
  .add({
    method: 'get',
    path: '/:uuid/checklist',
    permission: 'core.activities.view',
    params: uuidParam,
    handler: async ({ user, params }) => ({ data: await listChecklist(user, params.uuid) }),
  })
  .add({
    method: 'post',
    path: '/:uuid/checklist',
    permission: 'core.activities.update',
    params: uuidParam,
    body: checklistItemSchema,
    status: 201,
    handler: ({ ctx, user, params, body }) => addChecklistItem(ctx, user, params.uuid, body.label),
  })
  .add({
    method: 'put',
    path: '/:uuid/checklist/order',
    permission: 'core.activities.update',
    params: uuidParam,
    body: checklistOrderSchema,
    handler: async ({ ctx, user, params, body }) => {
      const rows = await db.transaction(async (trx) => {
        const activity = await getRow(activitiesDef, user, params.uuid, trx, { forUpdate: true });
        const items = await listRows(activity.id, trx);
        const known = new Set(items.map((i) => i.uuid as string));
        if (body.uuids.length !== items.length || body.uuids.some((u) => !known.has(u)))
          throw new AppError('VALIDATION_FAILED', 'Send every item of this checklist exactly once');
        for (const [position, uuid] of body.uuids.entries())
          await trx('activity_checklist_items').where({ uuid }).update({ position });
        await log(trx, ctx, activity, { order: { from: items.map((i) => i.uuid), to: body.uuids } });
        return listRows(activity.id, trx);
      });
      return { data: await toDtos(rows) };
    },
  });
