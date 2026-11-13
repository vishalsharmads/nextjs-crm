import { nextOccurrence, nextRule, recurrenceSchema } from '@app/shared';
import type { RequestContext } from '../../http/context';
import type { Db } from '../../db/knex';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { getGroup } from '../settings/settings.service';
import { copyChecklist } from './checklist';
import { endOfStage, recordStageHistory } from '../pipelines/stage-engine';

type Row = Record<string, unknown> & { id: number };

const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);

/**
 * When a recurring task is completed, create its next occurrence in the same transaction: same
 * subject, details, assignee, record, priority and custom values; a fresh copy of the checklist;
 * the reminder and meeting length moved by the same amount. Returns the new row, or null when the
 * task does not repeat or the series has ended.
 */
export async function spawnNextOccurrence(
  trx: Db,
  ctx: RequestContext,
  activityId: number,
  now = new Date(),
): Promise<Row | null> {
  const a = (await trx('activities').where({ id: activityId }).first()) as Row | undefined;
  if (!a?.recurrence) return null;
  const raw = typeof a.recurrence === 'string' ? JSON.parse(a.recurrence) : a.recurrence;
  const parsed = recurrenceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const rule = parsed.data;
  const anchorCol = a.type === 'meeting' ? 'start_at' : 'due_at';
  const anchor = ms(a[anchorCol]) ?? now.getTime();
  const { timezone } = await getGroup('general');
  const next = nextOccurrence(new Date(anchor), rule, timezone || 'UTC', now);
  if (!next) return null;
  const shift = (v: unknown) => {
    const t = ms(v);
    return t === null ? null : new Date(t - anchor + next.getTime());
  };
  // Already spawned (a retried request, or complete → reopen → complete): never twice.
  const existing = (await trx('activities')
    .where({ recurrence_parent_id: a.id })
    .whereNull('deleted_at')
    .first()) as Row | undefined;
  if (existing) return null;
  // With task statuses, the next occurrence starts open on the same pipeline.
  const firstOpen = a.pipeline_id
    ? await trx('pipeline_stages')
        .where({ pipeline_id: a.pipeline_id, active: true, is_won: false, is_lost: false })
        .orderBy('sort_order')
        .first('id')
    : undefined;
  const uuid = newUuid();
  const [id] = await trx('activities').insert({
    ...(firstOpen
      ? {
          pipeline_id: a.pipeline_id,
          stage_id: firstOpen.id,
          stage_entered_at: now,
          position: await endOfStage(trx, 'activity', firstOpen.id as number),
        }
      : {}),
    uuid,
    type: a.type,
    subject: a.subject,
    body: a.body,
    priority: a.priority,
    all_day: a.all_day,
    assignee_id: a.assignee_id,
    owner_id: a.owner_id,
    related_type: a.related_type,
    related_id: a.related_id,
    custom:
      a.custom === null || a.custom === undefined
        ? null
        : JSON.stringify(typeof a.custom === 'string' ? JSON.parse(a.custom) : a.custom),
    due_at: a.type === 'meeting' ? shift(a.due_at) : next,
    start_at: a.type === 'meeting' ? next : shift(a.start_at),
    end_at: shift(a.end_at),
    reminder_at: shift(a.reminder_at),
    recurrence: JSON.stringify(nextRule(rule)),
    recurrence_parent_id: a.id,
    created_by: a.created_by,
    updated_by: a.updated_by,
  });
  await copyChecklist(a.id, id as number, trx);
  if (firstOpen)
    await recordStageHistory(
      trx,
      'activity',
      [id as number],
      null,
      firstOpen.id as number,
      a.updated_by as number,
    );
  await audit(trx, ctx, {
    action: 'activity.created',
    entity: 'activity',
    entityId: id as number,
    entityUuid: uuid,
    diff: { recurrence: { from: a.uuid, to: next.toISOString() } },
  });
  return (await trx('activities').where({ id }).first()) as Row;
}
