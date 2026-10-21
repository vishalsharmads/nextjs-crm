import sanitizeHtml from 'sanitize-html';
import { activityCreateSchema, activityPatchSchema, type ActivityDto, type RelatedType } from '@app/shared';
import type { Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import type { ResourceDef } from '../records/types';
import { serializeCustom } from '../records/custom';
import {
  compact,
  customContext,
  dateField,
  ownerField,
  selectField,
  textField,
  timestampsFields,
} from '../records/common';
import { iso, userIdFromRef, userRefs } from '../records/hydrate';

type Row = Record<string, unknown> & { id: number };

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

async function resolveRelated(conn: Db, related: { type: RelatedType; uuid: string } | null | undefined) {
  if (related === undefined) return {};
  if (related === null) return { related_type: null, related_id: null };
  const meta = RELATED_TABLE[related.type];
  const row = await conn(meta.table).where({ uuid: related.uuid }).whereNull('deleted_at').first('id');
  if (!row)
    throw new AppError('VALIDATION_FAILED', 'The linked record was not found', [
      { path: 'related', message: 'Not found' },
    ]);
  return { related_type: related.type, related_id: row.id as number };
}

export const activitiesDef: ResourceDef<Row, ActivityDto> = {
  entity: 'activity',
  table: 'activities',
  resource: 'core.activities',
  ownerColumns: ['activities.assignee_id', 'activities.owner_id'],
  fulltext: [],
  likeColumns: ['activities.subject'],
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
        input.related as { type: RelatedType; uuid: string } | null | undefined,
      )),
    });
    if (input.completed !== undefined)
      row.completed_at = input.completed ? (existing?.completed_at ?? new Date()) : null;
    if (input.reminderAt !== undefined) row.reminded_at = null;
    if (!existing) {
      row.owner_id = user.id;
      if (row.assignee_id === undefined) row.assignee_id = user.id;
      // Notes are complete the moment they are written.
      if (row.type === 'note') row.completed_at = new Date();
    }
    return row;
  },
  async toDtos(rows, { user, conn }) {
    const [users, cf] = await Promise.all([
      userRefs(
        rows.flatMap((r) => [r.assignee_id as number, r.owner_id as number]),
        conn,
      ),
      customContext('activity', user),
    ]);
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
      };
    });
  },
};
