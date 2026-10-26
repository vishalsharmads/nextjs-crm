import type { z } from 'zod';
import type {
  DataSubjectEntity,
  PrivacyRequestDto,
  privacyRequestCreateSchema,
  privacyRequestUpdateSchema,
} from '@app/shared';
import type { AuthUser, RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';
import { userIdFromRef } from '../records/hydrate';
import { notify } from '../notifications/notifications.service';
import { effectiveCompliance, getGroup } from '../settings/settings.service';
import { addDays, todayIn } from '../commerce/documents';

type Row = Record<string, unknown>;
const NAME = "TRIM(CONCAT(COALESCE(s.first_name, ''), ' ', COALESCE(s.last_name, '')))";

function listQuery(conn: Db) {
  const qb = conn('privacy_requests as r')
    .leftJoin('users as a', 'a.id', 'r.assignee_id')
    .leftJoin('contacts as sc', function () {
      this.on('sc.id', '=', 'r.subject_id').andOnVal('r.subject_type', '=', 'contact');
    })
    .leftJoin('leads as sl', function () {
      this.on('sl.id', '=', 'r.subject_id').andOnVal('r.subject_type', '=', 'lead');
    })
    .select(
      'r.*',
      'a.uuid as assignee_uuid',
      'a.first_name as assignee_first',
      'a.last_name as assignee_last',
      'a.email as assignee_email',
      conn.raw('COALESCE(sc.uuid, sl.uuid) as subject_uuid'),
      conn.raw(`COALESCE(${NAME.replace(/s\./g, 'sc.')}, ${NAME.replace(/s\./g, 'sl.')}) as subject_name`),
    );
  return { qb };
}

function toDto(r: Row, today: string): PrivacyRequestDto {
  const due = String(r.due_at);
  const open = r.status === 'open' || r.status === 'in_progress';
  return {
    uuid: r.uuid as string,
    type: r.type as PrivacyRequestDto['type'],
    status: r.status as PrivacyRequestDto['status'],
    subject:
      r.subject_type && r.subject_uuid
        ? {
            entity: r.subject_type as DataSubjectEntity,
            uuid: r.subject_uuid as string,
            name: (r.subject_name as string) || '—',
          }
        : null,
    requesterName: (r.requester_name as string) ?? '',
    requesterEmail: (r.requester_email as string) ?? '',
    channel: r.channel as string,
    receivedAt: String(r.received_at),
    dueAt: due,
    overdue: open && due < today,
    notes: (r.notes as string | null) ?? '',
    resolution: (r.resolution as string | null) ?? '',
    assignee: r.assignee_uuid
      ? {
          uuid: r.assignee_uuid as string,
          name: `${r.assignee_first} ${r.assignee_last}`.trim() || (r.assignee_email as string),
        }
      : null,
    completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

async function workspaceToday() {
  return todayIn((await getGroup('general')).timezone);
}

async function subjectId(user: AuthUser, entity?: DataSubjectEntity, uuid?: string, conn: Db = db) {
  if (!entity || !uuid) return null;
  const row = await getRow(recordDefs[entity], user, uuid, conn, { withDeleted: true });
  return row.id as number;
}

export async function listRequests(query: {
  status?: string;
  overdue?: boolean;
  page: number;
  pageSize: number;
}) {
  const today = await workspaceToday();
  const { qb } = listQuery(db);
  if (query.status === 'active') qb.whereIn('r.status', ['open', 'in_progress']);
  else if (query.status) qb.where('r.status', query.status);
  if (query.overdue) qb.whereIn('r.status', ['open', 'in_progress']).where('r.due_at', '<', today);
  const total = Number(((await qb.clone().clearSelect().count({ c: '*' }).first()) as { c: number }).c);
  const rows = await qb
    .orderByRaw("FIELD(r.status, 'open', 'in_progress', 'completed', 'rejected')")
    .orderBy('r.due_at')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return {
    data: rows.map((r) => toDto(r, today)),
    meta: { page: query.page, pageSize: query.pageSize, total },
  };
}

export async function getRequest(uuid: string, conn: Db = db) {
  const { qb } = listQuery(conn);
  const row = await qb.where('r.uuid', uuid).first();
  if (!row) throw notFound('Privacy request');
  return toDto(row, await workspaceToday());
}

export async function createRequest(
  ctx: RequestContext,
  user: AuthUser,
  input: z.infer<typeof privacyRequestCreateSchema>,
) {
  if (!input.subjectUuid && !input.requesterEmail && !input.requesterName)
    throw new AppError('VALIDATION_FAILED', 'Link a record or enter who made the request', [
      { path: 'requesterEmail', message: 'Enter the requester or link a record' },
    ]);
  const { dsarDueDays } = await effectiveCompliance();
  const received = input.receivedAt ?? (await workspaceToday());
  const uuid = newUuid();
  await db.transaction(async (trx) => {
    const sid = await subjectId(user, input.subjectEntity, input.subjectUuid, trx);
    const assigneeId = await userIdFromRef(input.assigneeUuid ?? null, user, trx);
    const [id] = await trx('privacy_requests').insert({
      uuid,
      type: input.type,
      subject_type: sid ? input.subjectEntity : null,
      subject_id: sid,
      requester_name: input.requesterName,
      requester_email: input.requesterEmail,
      channel: input.channel,
      received_at: received,
      due_at: addDays(received, dsarDueDays),
      notes: input.notes,
      assignee_id: assigneeId ?? null,
      created_by: user.id,
    });
    await audit(trx, ctx, {
      action: 'privacy_request.created',
      entity: 'privacy_request',
      entityId: id,
      entityUuid: uuid,
      diff: { type: input.type, subject: input.subjectUuid ?? null },
    });
    if (assigneeId) await assignNotice(trx, assigneeId, uuid, user.id);
  });
  return getRequest(uuid);
}

export async function updateRequest(
  ctx: RequestContext,
  user: AuthUser,
  uuid: string,
  input: z.infer<typeof privacyRequestUpdateSchema>,
) {
  await db.transaction(async (trx) => {
    const row = await trx('privacy_requests').where({ uuid }).forUpdate().first();
    if (!row) throw notFound('Privacy request');
    const patch: Row = {};
    if (input.status !== undefined) {
      patch.status = input.status;
      patch.completed_at = input.status === 'completed' || input.status === 'rejected' ? new Date() : null;
    }
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.resolution !== undefined) patch.resolution = input.resolution;
    if (input.assigneeUuid !== undefined) {
      patch.assignee_id = (await userIdFromRef(input.assigneeUuid, user, trx)) ?? null;
      patch.reminded_at = null;
    }
    if (input.subjectUuid !== undefined) {
      const entity = input.subjectEntity ?? (row.subject_type as DataSubjectEntity | null) ?? 'contact';
      patch.subject_type = entity;
      patch.subject_id = await subjectId(user, entity, input.subjectUuid, trx);
    }
    if (!Object.keys(patch).length) return;
    await trx('privacy_requests').where({ id: row.id }).update(patch);
    await audit(trx, ctx, {
      action: 'privacy_request.updated',
      entity: 'privacy_request',
      entityId: row.id,
      entityUuid: uuid,
      diff: input,
    });
    if (patch.assignee_id) await assignNotice(trx, patch.assignee_id as number, uuid, user.id);
  });
  return getRequest(uuid);
}

function assignNotice(conn: Db, userId: number, uuid: string, actorId: number) {
  return notify(
    userId,
    {
      type: 'privacy_request.assigned',
      title: 'A privacy request was assigned to you',
      link: `/settings/privacy?request=${uuid}`,
      email: true,
    },
    { actorId, conn },
  );
}

/** Daily-ish: remind assignees (or no one) of requests due within three days, once. */
export async function remindDueRequests() {
  const today = await workspaceToday();
  const soon = addDays(today, 3);
  const rows = await db('privacy_requests')
    .whereIn('status', ['open', 'in_progress'])
    .whereNotNull('assignee_id')
    .whereNull('reminded_at')
    .where('due_at', '<=', soon);
  for (const r of rows) {
    await notify(r.assignee_id as number, {
      type: 'privacy_request.due',
      title: String(r.due_at) < today ? 'A privacy request is overdue' : 'A privacy request is due soon',
      body: `Due ${String(r.due_at)}`,
      link: `/settings/privacy?request=${r.uuid as string}`,
      email: true,
    });
    await db('privacy_requests').where({ id: r.id }).update({ reminded_at: new Date() });
  }
  return rows.length;
}
