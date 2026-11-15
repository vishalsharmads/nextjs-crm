import sanitizeHtml from 'sanitize-html';
import {
  activityCreateSchema,
  activityPatchSchema,
  recurrenceSchema,
  type ActivityDto,
  type Recurrence,
  type RelatedType,
  type ParticipantKind,
  type ParticipantRole,
} from '@app/shared';
import type { Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import type { AuthUser } from '../../http/context';
import { applyScope, can } from '../rbac/access';
import type { ResourceDef } from '../records/types';
import { serializeCustom } from '../records/custom';
import {
  compact,
  customContext,
  dateField,
  ownerField,
  relationField,
  selectField,
  textField,
  timestampsFields,
} from '../records/common';
import { iso, userIdFromRef, userRefs } from '../records/hydrate';
import { checklistCounts } from './checklist-counts';
import { spawnNextOccurrence } from './recurrence';
import { taskStageColumns } from './task-stage';
import { recordStageHistory } from '../pipelines/stage-engine';
import { participantsOf, resolveParticipants, setParticipants } from './participants';
import { standardLevels } from '../custom-fields/standard-visibility';
import { afterMeetingWrite } from '../calendar/invites';

type Row = Record<string, unknown> & { id: number };

function parseRecurrence(v: unknown): Recurrence | null {
  if (!v) return null;
  const parsed = recurrenceSchema.safeParse(typeof v === 'string' ? JSON.parse(v) : v);
  return parsed.success ? parsed.data : null;
}

export const RELATED_TABLE: Record<RelatedType, { table: string; title: string }> = {
  contact: { table: 'contacts', title: 'full_name' },
  organization: { table: 'organizations', title: 'name' },
  deal: { table: 'deals', title: 'title' },
  lead: { table: 'leads', title: 'full_name' },
};

/** Rich text is limited to simple formatting; scripts, styles and event handlers are stripped. */
export function sanitizeBody(html: string | null | undefined): string | null | undefined {
  if (html === undefined || html === null) return html;
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'a',
      'blockquote',
      'code',
      'pre',
      'h3',
      'h4',
    ],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) },
  });
}

/** The linked record must be one the user may view: missing and out of scope look the same. */
async function resolveRelated(
  conn: Db,
  user: AuthUser,
  related: { type: RelatedType; uuid: string } | null | undefined,
) {
  if (related === undefined) return {};
  if (related === null) return { related_type: null, related_id: null };
  const meta = RELATED_TABLE[related.type];
  // Imported lazily: the records registry imports this definition.
  const { recordDefs } = await import('../records/registry');
  const parent = recordDefs[related.type];
  const qb = conn(meta.table).where(`${meta.table}.uuid`, related.uuid).whereNull(`${meta.table}.deleted_at`);
  await applyScope(qb, user, parent.resource, parent.ownerColumns, conn);
  const row = can(user, `${parent.resource}.view`) ? await qb.first(`${meta.table}.id`) : undefined;
  if (!row)
    throw new AppError('VALIDATION_FAILED', 'The linked record was not found', [
      { path: 'related', message: 'Not found' },
    ]);
  return { related_type: related.type, related_id: row.id as number };
}

export const activitiesDef: ResourceDef<Row, ActivityDto> = {
  entity: 'activity',
  route: 'activities',
  table: 'activities',
  resource: 'core.activities',
  ownerColumns: ['activities.assignee_id', 'activities.owner_id'],
  fulltext: [],
  likeColumns: ['activities.subject'],
  notifyColumn: 'assignee_id',
  defaultSort: 'due_at',
  createSchema: activityCreateSchema,
  patchSchema: activityPatchSchema,
  fields: {
    type: selectField('activities.type'),
    subject: textField('activities.subject'),
    priority: selectField('activities.priority'),
    due_at: {
      kind: 'datetime',
      column: 'activities.due_at',
      sortable: true,
      filterable: true,
      sortExpr: 'activities.due_at IS NULL, activities.due_at',
    },
    start_at: dateField('activities.start_at'),
    completed_at: dateField('activities.completed_at'),
    completed: {
      kind: 'boolean',
      filter: (qb, cond) => {
        const yes = cond.value === true || cond.value === 'true';
        if ((cond.op === 'eq') === yes) qb.whereNotNull('activities.completed_at');
        else qb.whereNull('activities.completed_at');
      },
    },
    assignee: ownerField('activities', 'assignee_id'),
    owner: ownerField('activities'),
    related_type: selectField('activities.related_type'),
    stage: relationField('activities', 'stage_id', 'pipeline_stages', 'sort_order'),
    ...timestampsFields('activities'),
  },
  async toRow(input, { user, conn, existing }) {
    const row: Record<string, unknown> = compact({
      type: input.type as string | undefined,
      subject: input.subject as string | undefined,
      body: sanitizeBody(input.body as string | null | undefined),
      due_at: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt as string) : null,
      start_at:
        input.startAt === undefined ? undefined : input.startAt ? new Date(input.startAt as string) : null,
      end_at: input.endAt === undefined ? undefined : input.endAt ? new Date(input.endAt as string) : null,
      all_day: input.allDay as boolean | undefined,
      priority: input.priority as string | undefined,
      outcome: input.outcome as string | null | undefined,
      reminder_at:
        input.reminderAt === undefined
          ? undefined
          : input.reminderAt
            ? new Date(input.reminderAt as string)
            : null,
      assignee_id: await userIdFromRef(input.assigneeUuid as string | null | undefined, user, conn),
      ...(await resolveRelated(
        conn,
        user,
        input.related as { type: RelatedType; uuid: string } | null | undefined,
      )),
    });
    if (input.recurrence !== undefined)
      row.recurrence = input.recurrence ? JSON.stringify(input.recurrence) : null;
    if (input.completed !== undefined)
      row.completed_at = input.completed ? (existing?.completed_at ?? new Date()) : null;
    if (input.reminderAt !== undefined) row.reminded_at = null;
    if (!existing) {
      row.owner_id = user.id;
      if (row.assignee_id === undefined) row.assignee_id = user.id;
      // Notes are complete the moment they are written.
      if (row.type === 'note') row.completed_at = new Date();
    }
    Object.assign(row, await taskStageColumns(conn, input, row, existing));
    return row;
  },
  async afterWrite(id, input, { user, conn, ctx, existing }, op) {
    await afterMeetingWrite(conn, id, op, input.invite === true, existing);
    if (input.participants !== undefined)
      await setParticipants(
        conn,
        id,
        await resolveParticipants(
          conn,
          user,
          input.participants as { kind: ParticipantKind; uuid: string; role: ParticipantRole }[],
        ),
      );
    const now = await conn('activities').where({ id }).first('stage_id', 'completed_at');
    if (now?.stage_id && (existing?.stage_id ?? null) !== now.stage_id)
      await recordStageHistory(
        conn,
        'activity',
        [id],
        (existing?.stage_id as number | undefined) ?? null,
        now.stage_id,
        user.id,
      );
    // Completing a recurring task through an edit (or a move to the done stage) creates the next one.
    if (op === 'update' && existing && !existing.completed_at && now?.completed_at)
      await spawnNextOccurrence(conn, ctx, id);
  },
  async toDtos(rows, { user, conn }) {
    const stageIds = [...new Set(rows.map((r) => r.stage_id).filter(Boolean))] as number[];
    const [users, cf, checklists, stages] = await Promise.all([
      userRefs(
        rows.flatMap((r) => [r.assignee_id as number, r.owner_id as number]),
        conn,
      ),
      customContext('activity', user),
      checklistCounts(
        rows.map((r) => r.id),
        conn,
      ),
      stageIds.length
        ? (conn('pipeline_stages').whereIn('id', stageIds) as Promise<Record<string, unknown>[]>)
        : Promise.resolve([] as Record<string, unknown>[]),
    ]);
    const stageOf = new Map(stages.map((s) => [s.id as number, s]));
    const ids = rows.map((r) => r.id);
    const people = await participantsOf(conn, ids);
    // A participant's email follows the standard field rules of their record type.
    const emailHidden = new Set<string>();
    for (const kind of ['contact', 'lead', 'organization'] as const)
      if ((await standardLevels(kind, user)).email === 'hidden') emailHidden.add(kind);
    if (emailHidden.size)
      for (const list of people.values()) for (const p of list) if (emailHidden.has(p.kind)) p.email = null;
    // Emails: the thread each message is in, and how many messages that thread has.
    const emailIds = rows.filter((r) => r.type === 'email').map((r) => r.id);
    const threadOf = new Map<number, string>();
    const threadSize = new Map<string, number>();
    const trackingOf = new Map<number, NonNullable<ActivityDto['tracking']>>();
    if (emailIds.length) {
      const msgs = await conn('email_messages')
        .whereIn('activity_id', emailIds)
        .select(
          'activity_id',
          'thread_id',
          'tracking_token',
          'open_count',
          'last_opened_at',
          'click_count',
          'last_clicked_at',
        );
      for (const m of msgs) {
        if (m.thread_id) threadOf.set(m.activity_id as number, m.thread_id as string);
        if (m.tracking_token)
          trackingOf.set(m.activity_id as number, {
            opens: Number(m.open_count),
            lastOpenedAt: iso(m.last_opened_at),
            clicks: Number(m.click_count),
            lastClickedAt: iso(m.last_clicked_at),
          });
      }
      const threads = [...new Set(threadOf.values())];
      if (threads.length)
        for (const t of (await conn('email_messages')
          .whereIn('thread_id', threads)
          .groupBy('thread_id')
          .select('thread_id')
          .count({ n: '*' })) as { thread_id: string; n: number }[])
          threadSize.set(t.thread_id, Number(t.n));
    }
    const related = new Map<string, { uuid: string; title: string }>();
    for (const type of Object.keys(RELATED_TABLE) as RelatedType[]) {
      const ids = rows.filter((r) => r.related_type === type).map((r) => r.related_id as number);
      if (!ids.length) continue;
      const meta = RELATED_TABLE[type];
      for (const x of await conn(meta.table)
        .whereIn('id', ids)
        .select('id', 'uuid', `${meta.title} as title`))
        related.set(`${type}:${x.id}`, { uuid: x.uuid, title: x.title || '' });
    }
    const now = Date.now();
    return rows.map((r) => {
      const rel = r.related_type ? related.get(`${r.related_type}:${r.related_id}`) : undefined;
      return {
        uuid: r.uuid as string,
        type: r.type as ActivityDto['type'],
        subject: r.subject as string,
        body: (r.body as string | null) ?? null,
        dueAt: iso(r.due_at),
        startAt: iso(r.start_at),
        endAt: iso(r.end_at),
        allDay: !!r.all_day,
        completedAt: iso(r.completed_at),
        priority: r.priority as ActivityDto['priority'],
        outcome: (r.outcome as string | null) ?? null,
        assignee: users.get(r.assignee_id as number) ?? null,
        owner: users.get(r.owner_id as number) ?? null,
        related: rel ? { type: r.related_type as RelatedType, ...rel } : null,
        reminderAt: iso(r.reminder_at),
        custom: serializeCustom(r.custom, cf.defs, cf.levels),
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
        overdue: !r.completed_at && !!r.due_at && new Date(r.due_at as string).getTime() < now,
        participants: people.get(r.id) ?? [],
        tracking: trackingOf.get(r.id) ?? null,
        thread: threadOf.has(r.id)
          ? { id: threadOf.get(r.id)!, count: threadSize.get(threadOf.get(r.id)!) ?? 1 }
          : null,
        stage: (() => {
          const st = stageOf.get(r.stage_id as number);
          return st
            ? {
                uuid: st.uuid as string,
                key: st.key as string,
                name: st.name as string,
                color: (st.color as string | null) ?? null,
                isWon: !!st.is_won,
                isLost: !!st.is_lost,
              }
            : null;
        })(),
        recurrence: parseRecurrence(r.recurrence),
        checklist: checklists.get(r.id) ?? { done: 0, total: 0 },
      };
    });
  },
};
