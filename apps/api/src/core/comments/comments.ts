import type { z } from 'zod';
import { recordCommentPatchSchema, recordCommentSchema, type RecordCommentDto } from '@app/shared';
import type { AuthUser, RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { logAccess } from '../audit/access-log';
import { can, loadAccess } from '../rbac/access';
import { getRow } from '../records/service';
import { iso, userRefs } from '../records/hydrate';
import { recordBasePath } from '../records/paths';
import { snake } from '../records/record-type';
import type { ResourceDef } from '../records/types';
import { notify } from '../notifications/notifications.service';
import { emit } from '../events/events';
import { sanitizeBody } from '../activities/activities.def';

type Row = Record<string, unknown> & { id: number };

const CORE_TITLES: Record<string, string> = {
  contact: 'full_name',
  organization: 'name',
  lead: 'full_name',
  deal: 'title',
};

/** The column that names a record of this type. */
export function titleColumn(def: ResourceDef): string | null {
  return CORE_TITLES[def.entity] ?? (def.meta?.titleColumn ? snake(def.meta.titleColumn) : null);
}

async function toDtos(rows: Row[], viewer: AuthUser, conn: Db = db): Promise<RecordCommentDto[]> {
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

/** An active user as the access checks see them. */
async function asUser(id: number): Promise<AuthUser | null> {
  const person = await db('users')
    .where({ id, status: 'active' })
    .whereNull('deleted_at')
    .first('id', 'uuid', 'email', 'first_name', 'last_name');
  if (!person) return null;
  return {
    id,
    uuid: person.uuid,
    email: person.email,
    firstName: person.first_name,
    lastName: person.last_name,
    ...(await loadAccess(id)),
    sessionId: null,
  };
}

/**
 * The people among `userIds` who may open this record (permission and scope). A mention or a
 * notification must never reveal a record to someone outside their scope.
 */
export async function viewersOf(def: ResourceDef, recordUuid: string, userIds: number[]): Promise<number[]> {
  const out: number[] = [];
  for (const id of [...new Set(userIds)]) {
    const u = await asUser(id);
    if (!u || !can(u, `${def.resource}.view`)) continue;
    try {
      await getRow(def, u, recordUuid);
      out.push(id);
    } catch {
      // Out of scope: not notified.
    }
  }
  return out;
}

/** Comments on one record, oldest first. Scope applies through the record. */
export async function listRecordComments(
  def: ResourceDef,
  ctx: RequestContext,
  user: AuthUser,
  recordUuid: string,
): Promise<RecordCommentDto[]> {
  const record = await getRow(def, user, recordUuid);
  const rows = (await db('record_comments')
    .where({ entity: def.entity, record_id: record.id })
    .orderBy('id')
    .limit(500)) as Row[];
  await logAccess(ctx, {
    action: 'view',
    entity: def.entity,
    entityId: record.id as number,
    entityUuid: recordUuid,
    detail: { comments: rows.length },
  });
  return toDtos(rows, user);
}

export async function addRecordComment(
  def: ResourceDef,
  ctx: RequestContext,
  user: AuthUser,
  recordUuid: string,
  raw: unknown,
): Promise<RecordCommentDto> {
  const input = recordCommentSchema.parse(raw);
  const mentionedIds = input.mentions.length
    ? ((await db('users').whereIn('uuid', input.mentions).pluck('id')) as number[])
    : [];
  const mentions = await viewersOf(
    def,
    recordUuid,
    mentionedIds.filter((id) => id !== user.id),
  );
  const { row, record } = await db.transaction(async (trx) => {
    const record = await getRow(def, user, recordUuid, trx);
    const uuid = newUuid();
    const [id] = await trx('record_comments').insert({
      uuid,
      entity: def.entity,
      record_id: record.id,
      author_id: user.id,
      body: sanitizeBody(input.body) ?? '',
      mentions: JSON.stringify(mentions),
    });
    await audit(trx, ctx, {
      action: `${def.entity}.comment_added`,
      entity: def.entity,
      entityId: record.id as number,
      entityUuid: recordUuid,
      diff: { comment: { from: null, to: uuid } },
    });
    return { row: (await trx('record_comments').where({ id }).first()) as Row, record };
  });

  const col = titleColumn(def);
  const title = (col && (record[col] as string | null)) || 'a record';
  const link = `${recordBasePath(def)}/${recordUuid}`;
  for (const id of mentions)
    await notify(
      id,
      {
        type: 'comment.mentioned',
        title: `${user.firstName} mentioned you on “${title}”`,
        link,
        email: true,
      },
      { actorId: user.id },
    );
  // Owners hear about new comments on their records (never about their own, once each).
  const owners = def.ownerColumns
    .map((c) => record[c.split('.').pop()!])
    .filter((id): id is number => typeof id === 'number' && !mentions.includes(id));
  for (const id of await viewersOf(def, recordUuid, owners))
    await notify(
      id,
      { type: 'comment.created', title: `${user.firstName} commented on “${title}”`, link },
      { actorId: user.id },
    );
  await emit({
    type: 'comment.created',
    entity: def.entity,
    uuid: recordUuid,
    record: { uuid: recordUuid, comment: { uuid: row.uuid as string, author: user.uuid } },
    actorId: user.id,
  });
  return (await toDtos([row], user))[0]!;
}

/** A comment on a record the caller can see, which they wrote (or they are an admin). */
async function ownComment(
  def: ResourceDef,
  user: AuthUser,
  recordUuid: string,
  commentUuid: string,
  conn: Db,
) {
  const record = await getRow(def, user, recordUuid, conn);
  const row = (await conn('record_comments')
    .where({ uuid: commentUuid, entity: def.entity, record_id: record.id })
    .first()) as Row | undefined;
  if (!row) throw notFound('Comment');
  if (!user.isAdmin && row.author_id !== user.id)
    throw new AppError('FORBIDDEN', 'Only the author can change this comment');
  return { row, record };
}

export async function editRecordComment(
  def: ResourceDef,
  ctx: RequestContext,
  user: AuthUser,
  recordUuid: string,
  commentUuid: string,
  raw: unknown,
): Promise<RecordCommentDto> {
  const input: z.output<typeof recordCommentPatchSchema> = recordCommentPatchSchema.parse(raw);
  const row = await db.transaction(async (trx) => {
    const { row, record } = await ownComment(def, user, recordUuid, commentUuid, trx);
    await trx('record_comments')
      .where({ id: row.id })
      .update({ body: sanitizeBody(input.body) ?? '', edited_at: new Date() });
    await audit(trx, ctx, {
      action: `${def.entity}.comment_edited`,
      entity: def.entity,
      entityId: record.id as number,
      entityUuid: recordUuid,
      diff: { comment: { from: commentUuid, to: commentUuid } },
    });
    return (await trx('record_comments').where({ id: row.id }).first()) as Row;
  });
  return (await toDtos([row], user))[0]!;
}

export async function deleteRecordComment(
  def: ResourceDef,
  ctx: RequestContext,
  user: AuthUser,
  recordUuid: string,
  commentUuid: string,
) {
  await db.transaction(async (trx) => {
    const { row, record } = await ownComment(def, user, recordUuid, commentUuid, trx);
    await trx('record_comments').where({ id: row.id }).delete();
    await audit(trx, ctx, {
      action: `${def.entity}.comment_deleted`,
      entity: def.entity,
      entityId: record.id as number,
      entityUuid: recordUuid,
      diff: { comment: { from: commentUuid, to: null } },
    });
  });
}

/** Comments for the timeline, newest first, before a point in time. */
export async function timelineComments(
  entity: string,
  recordId: number,
  viewer: AuthUser,
  before: Date,
  limit: number,
): Promise<RecordCommentDto[]> {
  const rows = (await db('record_comments')
    .where({ entity, record_id: recordId })
    .where('created_at', '<', before)
    .orderBy('created_at', 'desc')
    .limit(limit)) as Row[];
  return toDtos(rows, viewer);
}
