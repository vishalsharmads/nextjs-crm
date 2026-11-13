import { z } from 'zod';
import { activityCommentPatchSchema, activityCommentSchema, type ActivityCommentDto } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser, RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { can, loadAccess } from '../rbac/access';
import { getRow } from '../records/service';
import { uuidParam } from '../records/routes';
import { iso, userRefs } from '../records/hydrate';
import { notify } from '../notifications/notifications.service';
import { activitiesDef, sanitizeBody } from './activities.def';

type Row = Record<string, unknown> & { id: number };

const commentParam = z.object({ commentUuid: z.uuid() });

async function toDtos(rows: Row[], viewer: AuthUser, conn: Db = db): Promise<ActivityCommentDto[]> {
  const mentionIds = rows.flatMap((r) => (r.mentions as number[] | null) ?? []);
  const refs = await userRefs([...rows.map((r) => r.author_id as number), ...mentionIds], conn);
  return rows.map((r) => ({
    uuid: r.uuid as string,
    body: r.body as string,
    author: refs.get(r.author_id as number) ?? null,
    mentions: ((r.mentions as number[] | null) ?? []).flatMap((id) => refs.get(id) ?? []),
    createdAt: iso(r.created_at)!,
    editedAt: iso(r.edited_at),
    canEdit: viewer.isAdmin || r.author_id === viewer.id,
  }));
}

/** Users who may see this task: a mention must never reveal a task outside someone's scope. */
async function viewersAmong(userIds: number[], activityUuid: string): Promise<number[]> {
  const out: number[] = [];
  for (const id of userIds) {
    const person = await db('users')
      .where({ id, status: 'active' })
      .whereNull('deleted_at')
      .first('id', 'uuid', 'email', 'first_name', 'last_name');
    if (!person) continue;
    const u: AuthUser = {
      id,
      uuid: person.uuid,
      email: person.email,
      firstName: person.first_name,
      lastName: person.last_name,
      ...(await loadAccess(id)),
      sessionId: null,
    };
    if (!can(u, 'core.activities.view')) continue;
    try {
      await getRow(activitiesDef, u, activityUuid);
      out.push(id);
    } catch {
      // Out of scope: not notified.
    }
  }
  return out;
}

async function commentRow(user: AuthUser, commentUuid: string, conn: Db = db) {
  const row = (await conn('activity_comments')
    .where({ uuid: commentUuid })
    .whereNull('deleted_at')
    .first()) as Row | undefined;
  if (!row) throw notFound('Comment');
  // The parent task must be visible to the caller (scope), or the comment does not exist for them.
  const activity = await conn('activities').where({ id: row.activity_id }).first('uuid');
  if (!activity) throw notFound('Comment');
  await getRow(activitiesDef, user, activity.uuid as string, conn);
  if (!user.isAdmin && row.author_id !== user.id)
    throw new AppError('FORBIDDEN', 'Only the author can change this comment');
  return { row, activityUuid: activity.uuid as string };
}

export async function addComment(
  ctx: RequestContext,
  user: AuthUser,
  activityUuid: string,
  input: z.output<typeof activityCommentSchema>,
): Promise<ActivityCommentDto> {
  const mentionedIds = input.mentions.length
    ? ((await db('users').whereIn('uuid', input.mentions).pluck('id')) as number[])
    : [];
  const mentions = await viewersAmong(
    mentionedIds.filter((id) => id !== user.id),
    activityUuid,
  );
  const { row, activity } = await db.transaction(async (trx) => {
    const activity = await getRow(activitiesDef, user, activityUuid, trx);
    const uuid = newUuid();
    const [id] = await trx('activity_comments').insert({
      uuid,
      activity_id: activity.id,
      author_id: user.id,
      body: sanitizeBody(input.body) ?? '',
      mentions: JSON.stringify(mentions),
    });
    await audit(trx, ctx, {
      action: 'activity.comment_added',
      entity: 'activity',
      entityId: activity.id,
      entityUuid: activityUuid,
      diff: { comment: { from: null, to: uuid } },
    });
    return { row: (await trx('activity_comments').where({ id }).first()) as Row, activity };
  });
  const link = `/tasks/${activityUuid}`;
  const title = (activity.subject as string) || 'a task';
  for (const id of mentions)
    await notify(
      id,
      {
        type: 'activity.mentioned',
        title: `${user.firstName} mentioned you on “${title}”`,
        link,
        email: true,
      },
      { actorId: user.id },
    );
  // The assignee and creator hear about new comments too (once, and never about their own).
  const followers = [activity.assignee_id, activity.owner_id].filter(
    (id, i, all): id is number => typeof id === 'number' && !mentions.includes(id) && all.indexOf(id) === i,
  );
  for (const id of await viewersAmong(followers, activityUuid))
    await notify(
      id,
      { type: 'activity.commented', title: `${user.firstName} commented on “${title}”`, link },
      { actorId: user.id },
    );
  return (await toDtos([row], user))[0]!;
}

/** Comments on a task, oldest first (scope applies through the task). */
export async function listComments(user: AuthUser, activityUuid: string): Promise<ActivityCommentDto[]> {
  const activity = await getRow(activitiesDef, user, activityUuid);
  const rows = (await db('activity_comments')
    .where({ activity_id: activity.id })
    .whereNull('deleted_at')
    .orderBy('id')
    .limit(500)) as Row[];
  return toDtos(rows, user);
}

export const activityCommentRoutes = defineRoutes('/activities', ['activities'])
  .add({
    method: 'patch',
    path: '/comments/:commentUuid',
    permission: 'core.activities.update',
    params: commentParam,
    body: activityCommentPatchSchema,
    handler: async ({ ctx, user, params, body }) => {
      const row = await db.transaction(async (trx) => {
        const { row } = await commentRow(user, params.commentUuid, trx);
        await trx('activity_comments')
          .where({ id: row.id })
          .update({ body: sanitizeBody(body.body) ?? '', edited_at: new Date() });
        await audit(trx, ctx, {
          action: 'activity.comment_edited',
          entity: 'activity',
          entityId: row.activity_id as number,
          diff: { comment: { from: params.commentUuid, to: params.commentUuid } },
        });
        return (await trx('activity_comments').where({ id: row.id }).first()) as Row;
      });
      return (await toDtos([row], user))[0];
    },
  })
  .add({
    method: 'delete',
    path: '/comments/:commentUuid',
    permission: 'core.activities.update',
    params: commentParam,
    status: 204,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const { row, activityUuid } = await commentRow(user, params.commentUuid, trx);
        // Removed outright: a deleted comment should not linger as personal data.
        await trx('activity_comments').where({ id: row.id }).delete();
        await audit(trx, ctx, {
          action: 'activity.comment_deleted',
          entity: 'activity',
          entityId: row.activity_id as number,
          entityUuid: activityUuid,
          diff: { comment: { from: params.commentUuid, to: null } },
        });
      });
    },
  })
  .add({
    method: 'get',
    path: '/:uuid/comments',
    permission: 'core.activities.view',
    params: uuidParam,
    handler: async ({ user, params }) => ({ data: await listComments(user, params.uuid) }),
  })
  .add({
    method: 'post',
    path: '/:uuid/comments',
    permission: 'core.activities.update',
    params: uuidParam,
    body: activityCommentSchema,
    status: 201,
    handler: ({ ctx, user, params, body }) => addComment(ctx, user, params.uuid, body),
  });
