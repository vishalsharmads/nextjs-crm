import { AsyncLocalStorage } from 'node:async_hooks';
import Handlebars from 'handlebars';
import { z } from 'zod';
import {
  entityKeySchema,
  filterSchema,
  isGroup,
  type FilterCondition,
  type FilterNode,
  toPatch,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser, RequestContext } from '../../http/context';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { logger } from '../../lib/logger';
import { enqueue, every, registerJob } from '../../lib/jobs';
import { audit } from '../audit/audit.service';
import { loadAccess } from '../rbac/access';
import { eventDepth, eventTypeSchema, eventTypes, onEvent, type DomainEvent } from '../events/events';
import { notify } from '../notifications/notifications.service';
import { findRecordDef, recordDefs } from '../records/registry';
import { createRecord, getRecord, listRecords, updateRecord } from '../records/service';
import { ensureTags } from '../records/hydrate';
import { sendMail } from '../../lib/mailer';
import { getBranding, getGroup } from '../settings/settings.service';
import { eventTouchesRestricted, restrictedRecipients } from '../privacy/privacy.service';
import { unsubscribeToken } from '../privacy/unsubscribe';
import { env } from '../../config/env';

/** Automations triggered by automations stop here, so a rule can never loop forever. */
const MAX_DEPTH = 3;

// ---------- Definitions ----------

const recipient = z.union([z.enum(['owner', 'actor', 'record']), z.uuid()]);

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update_field'), field: z.string().max(80), value: z.unknown() }),
  z.object({
    type: z.literal('create_task'),
    subject: z.string().min(1).max(255),
    dueInDays: z.number().int().min(0).max(365).default(1),
    assignee: recipient.default('owner'),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }),
  z.object({
    type: z.literal('notify'),
    to: recipient.default('owner'),
    title: z.string().min(1).max(255),
    body: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal('send_email'),
    to: recipient.default('record'),
    subject: z.string().min(1).max(255),
    body: z.string().min(1).max(20000),
  }),
  z.object({ type: z.literal('add_tags'), tags: z.array(z.string().min(1).max(64)).min(1).max(20) }),
  z.object({ type: z.literal('remove_tags'), tags: z.array(z.string().min(1).max(64)).min(1).max(20) }),
  /** Assign the record (its owner, or a task's assignee) to one of these people, taking turns. */
  z.object({ type: z.literal('assign'), users: z.array(z.uuid()).min(1).max(50) }),
  z.object({ type: z.literal('add_note'), body: z.string().min(1).max(20000) }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

/** Trigger of time-based rules: run over the records that match the conditions. */
export const SCHEDULE_TRIGGER = 'schedule';

const scheduleSchema = z.object({
  entity: entityKeySchema,
  frequency: z.enum(['daily', 'weekly']),
  /** 0 = Sunday, for weekly rules. */
  weekday: z.number().int().min(0).max(6).default(1),
  /** Local time in the workspace time zone. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
});
export type AutomationSchedule = z.infer<typeof scheduleSchema>;

const automationShape = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().max(500).default(''),
  triggerEvent: z.union([z.literal(SCHEDULE_TRIGGER), eventTypeSchema]),
  /** Wait this long after the event, then re-check the conditions against the record as it is then. */
  delayMinutes: z.number().int().min(0).max(43_200).default(0),
  schedule: scheduleSchema.nullish(),
  conditions: filterSchema.nullish(),
  actions: z.array(actionSchema).min(1).max(10),
  active: z.boolean().default(true),
});

const scheduleRule = (b: { triggerEvent?: string; schedule?: AutomationSchedule | null }) =>
  b.triggerEvent === undefined || (b.triggerEvent === SCHEDULE_TRIGGER) === !!b.schedule;
const scheduleMessage = {
  message: 'A schedule is needed for scheduled rules, and only for them',
  path: ['schedule'],
};
const automationBody = automationShape.refine(scheduleRule, scheduleMessage);
const automationPatch = toPatch(automationShape);

/** The UTC instant of a wall-clock time in a time zone (handles daylight saving). */
function zonedInstant(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime()));
}

/** Next run of a schedule strictly after `after`, in the workspace time zone. */
export function nextRun(schedule: AutomationSchedule, timeZone: string, after = new Date()): Date {
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      d,
    );
  for (let i = 0; i < 8; i++) {
    const date = day(new Date(after.getTime() + i * 86_400_000));
    const at = zonedInstant(date, schedule.time, timeZone);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (at > after && (schedule.frequency === 'daily' || weekday === schedule.weekday)) return at;
  }
  return new Date(after.getTime() + 7 * 86_400_000);
}

// ---------- Condition evaluation (in memory, against the event's record) ----------

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Resolve an API field key against a record DTO. Objects compare by uuid, key and name. */
function resolve(record: Record<string, unknown>, field: string): unknown[] {
  let v: unknown;
  if (field.startsWith('cf.')) v = (record.custom as Record<string, unknown> | undefined)?.[field.slice(3)];
  else v = record[camel(field)] ?? record[field];
  const values = Array.isArray(v) ? v : [v];
  return values.flatMap((x) =>
    x && typeof x === 'object'
      ? Object.values(x as Record<string, unknown>).filter(
          (y) => typeof y === 'string' || typeof y === 'number',
        )
      : [x],
  );
}

function matchCondition(c: FilterCondition, e: DomainEvent): boolean {
  if (c.field === 'changed') {
    const wanted = (Array.isArray(c.value) ? c.value : [c.value]).map(String);
    const changed = Object.keys(e.changes ?? {}).map((k) =>
      (k.endsWith('_id') ? k.slice(0, -3) : k).replace(/^custom\./, 'cf.'),
    );
    return wanted.some((w) => changed.includes(w));
  }
  const actual = resolve(e.record, c.field);
  const value = c.value;
  const list = (Array.isArray(value) ? value : [value]).map(String);
  const nums = actual.map(Number).filter((n) => !Number.isNaN(n));
  switch (c.op) {
    case 'eq':
      return actual.map(String).includes(String(value));
    case 'neq':
      return !actual.map(String).includes(String(value));
    case 'in':
      return actual.some((a) => list.includes(String(a)));
    case 'nin':
      return !actual.some((a) => list.includes(String(a)));
    case 'contains':
      return actual.some((a) =>
        String(a ?? '')
          .toLowerCase()
          .includes(String(value ?? '').toLowerCase()),
      );
    case 'starts_with':
      return actual.some((a) =>
        String(a ?? '')
          .toLowerCase()
          .startsWith(String(value ?? '').toLowerCase()),
      );
    case 'gt':
      return nums.some((n) => n > Number(value));
    case 'gte':
      return nums.some((n) => n >= Number(value));
    case 'lt':
      return nums.some((n) => n < Number(value));
    case 'lte':
      return nums.some((n) => n <= Number(value));
    case 'is_empty':
      return actual.every((a) => a === null || a === undefined || a === '');
    case 'is_not_empty':
      return actual.some((a) => a !== null && a !== undefined && a !== '');
    default:
      return false;
  }
}

export function matches(node: FilterNode | null | undefined, e: DomainEvent): boolean {
  if (!node) return true;
  if (isGroup(node))
    return 'and' in node ? node.and.every((n) => matches(n, e)) : node.or.some((n) => matches(n, e));
  return matchCondition(node, e);
}

// ---------- Execution ----------

const render = (tpl: string, ctx: object) => Handlebars.compile(tpl, { noEscape: false })(ctx);

async function runAs(userId: number): Promise<AuthUser> {
  const u = await db('users').where({ id: userId, status: 'active' }).whereNull('deleted_at').first();
  if (!u) throw new Error('The automation owner is no longer active');
  return {
    id: u.id,
    uuid: u.uuid,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    sessionId: null,
    ...(await loadAccess(u.id)),
  };
}

async function userIdFor(to: string, e: DomainEvent): Promise<number | null> {
  if (to === 'actor') return e.actorId;
  if (to === 'owner') {
    const owner = (e.record.owner ?? e.record.assignee) as { uuid?: string } | null;
    if (!owner?.uuid) return null;
    return ((await db('users').where({ uuid: owner.uuid }).first('id'))?.id as number | undefined) ?? null;
  }
  if (to === 'record') return null;
  return ((await db('users').where({ uuid: to }).first('id'))?.id as number | undefined) ?? null;
}

/** The automation a job is running, for actions that keep state per rule (assign). */
const automationId = new AsyncLocalStorage<number>();

async function runAction(
  action: AutomationAction,
  e: DomainEvent,
  user: AuthUser,
  ctx: RequestContext,
): Promise<string> {
  const def = findRecordDef(e.entity);
  const vars = { record: e.record, event: { type: e.type } };
  switch (action.type) {
    case 'update_field': {
      if (!def) return 'skipped: not a record';
      const input = action.field.startsWith('cf.')
        ? { custom: { [action.field.slice(3)]: action.value } }
        : { [action.field]: action.value };
      await updateRecord(def, ctx, user, e.uuid, input);
      return `updated ${action.field}`;
    }
    case 'create_task': {
      const assignee = await userIdFor(action.assignee, e);
      const assigneeUuid = assignee
        ? ((await db('users').where({ id: assignee }).first('uuid'))?.uuid as string)
        : null;
      const related = ['contact', 'organization', 'deal', 'lead'].includes(e.entity)
        ? { type: e.entity, uuid: e.uuid }
        : null;
      await createRecord(recordDefs.activity, ctx, user, {
        type: 'task',
        subject: render(action.subject, vars),
        dueAt: new Date(Date.now() + action.dueInDays * 86_400_000).toISOString(),
        priority: action.priority,
        assigneeUuid,
        related,
      });
      return 'task created';
    }
    case 'notify': {
      const to = await userIdFor(action.to, e);
      if (!to) return 'skipped: no recipient';
      await notify(to, {
        type: 'automation',
        title: render(action.title, vars),
        body: action.body ? render(action.body, vars) : null,
        email: false,
      });
      return 'notified';
    }
    case 'send_email': {
      let address: string | null = null;
      if (action.to === 'record') address = (e.record.email as string | null) ?? null;
      else {
        const id = await userIdFor(action.to, e);
        address = id ? ((await db('users').where({ id }).first('email'))?.email as string) : null;
      }
      if (!address) return 'skipped: no email address';
      // Module records hold no opt-out of their own: never email a restricted person through them.
      if (action.to === 'record' && def?.moduleKey && (await restrictedRecipients([address])))
        return 'skipped: processing restricted';
      const branding = await getBranding();
      let html = render(action.body, vars);
      let headers: Record<string, string> | undefined;
      // Automated email to the person counts as marketing: honour the opt-out and offer an unsubscribe.
      if (action.to === 'record' && (e.entity === 'contact' || e.entity === 'lead')) {
        const row = await db(recordDefs[e.entity].table).where({ uuid: e.uuid }).first('marketing_opt_out');
        if (row?.marketing_opt_out) return 'skipped: opted out of marketing email';
        const token = encodeURIComponent(unsubscribeToken(e.entity, e.uuid));
        const page = `${env.APP_URL}/unsubscribe?token=${token}`;
        html += `<p style="font-size:12px"><a href="${page}">Unsubscribe</a></p>`;
        headers = {
          'List-Unsubscribe': `<${env.APP_URL}/api/v1/public/privacy/unsubscribe?token=${token}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        };
      }
      await sendMail({
        to: address,
        subject: render(action.subject, vars),
        html,
        text: html.replace(/<[^>]+>/g, ''),
        fromName: branding.emailFromName || branding.appName,
        fromAddress: branding.emailFromAddress || undefined,
        headers,
      });
      return `emailed ${address}`;
    }
    case 'assign': {
      if (!def) return 'skipped: not a record';
      // Take turns, skipping people who are no longer active. The cursor moves in one statement,
      // so parallel runs never pick the same position.
      const id = automationId.getStore() ?? 0;
      let pick: string | null = null;
      for (let tries = 0; tries < action.users.length && !pick; tries++) {
        await db('automations').where({ id }).increment('assign_cursor', 1);
        const row = await db('automations').where({ id }).first('assign_cursor');
        const candidate = action.users[(Number(row?.assign_cursor ?? 1) - 1) % action.users.length]!;
        const active = await db('users')
          .where({ uuid: candidate, status: 'active' })
          .whereNull('deleted_at')
          .first('id');
        if (active) pick = candidate;
      }
      if (!pick) return 'skipped: nobody in the list is active';
      await updateRecord(
        def,
        ctx,
        user,
        e.uuid,
        e.entity === 'activity' ? { assigneeUuid: pick } : { ownerUuid: pick },
      );
      return `assigned to ${pick}`;
    }
    case 'add_note': {
      if (!['contact', 'organization', 'deal', 'lead'].includes(e.entity))
        return 'skipped: cannot add a note here';
      await createRecord(recordDefs.activity, ctx, user, {
        type: 'note',
        body: render(action.body, vars),
        related: { type: e.entity, uuid: e.uuid },
      });
      return 'note added';
    }
    case 'remove_tags': {
      if (!def || e.entity === 'activity' || def.moduleKey) return 'skipped: cannot tag';
      const row = await db(def.table).where({ uuid: e.uuid }).first('id');
      if (!row) return 'skipped: record gone';
      const ids = await db('tags').whereIn('name', action.tags).pluck('id');
      const n = ids.length
        ? await db('taggables')
            .whereIn('tag_id', ids)
            .where({ taggable_type: e.entity, taggable_id: row.id })
            .delete()
        : 0;
      return `removed ${n} tag(s)`;
    }
    case 'add_tags': {
      if (!def || e.entity === 'activity' || def.moduleKey) return 'skipped: cannot tag';
      const row = await db(def.table).where({ uuid: e.uuid }).first('id');
      if (!row) return 'skipped: record gone';
      const ids = await ensureTags(action.tags, user, db);
      for (const tag_id of ids)
        await db('taggables')
          .insert({ tag_id, taggable_type: e.entity, taggable_id: row.id })
          .onConflict(['tag_id', 'taggable_type', 'taggable_id'])
          .ignore();
      return `tagged ${action.tags.join(', ')}`;
    }
  }
}

registerJob('automation.run', async (job) => {
  const automation = await db('automations')
    .where({ id: job.payload.automationId as number, active: true })
    .first();
  if (!automation) return null;
  let event = job.payload.event as DomainEvent;
  const log: string[] = [];
  let status: 'succeeded' | 'skipped' | 'failed' = 'succeeded';
  try {
    // Every run judges the record as the rule's owner sees it now, so conditions and templates
    // never reveal records or fields the owner may not read (the event carries the actor's view).
    let gone = false;
    const owner = await runAs(automation.created_by);
    if (!event.type.endsWith('.deleted')) {
      const def = findRecordDef(event.entity);
      const fresh = def ? await getRecord(def, owner, event.uuid).catch(() => null) : null;
      if (fresh) event = { ...event, record: fresh as Record<string, unknown> };
      else gone = true;
    } else if (!owner.isAdmin && event.record) {
      // A deleted record can't be read again; custom values may be hidden from the owner.
      const { custom: _custom, ...rest } = event.record;
      event = { ...event, record: rest };
    }
    if (gone) {
      status = 'skipped';
      log.push('record gone or out of reach');
    } else if (await eventTouchesRestricted(event)) {
      status = 'skipped';
      log.push('processing restricted');
    } else if (!matches(automation.conditions as FilterNode | null, event)) {
      status = 'skipped';
      log.push('conditions not met');
    } else {
      const user = owner;
      const ctx: RequestContext = {
        requestId: `automation:${automation.uuid}`,
        ip: null,
        userAgent: null,
        user,
      };
      // Events emitted by these actions carry depth + 1, so chains stop at MAX_DEPTH.
      await automationId.run(automation.id as number, () =>
        eventDepth.run(event.depth + 1, async () => {
          for (const action of automation.actions as AutomationAction[])
            log.push(await runAction(action, event, user, ctx));
        }),
      );
    }
  } catch (err) {
    status = 'failed';
    log.push((err as Error).message);
    logger.warn({ err, automation: automation.uuid }, 'Automation failed');
  }
  await db('automation_runs').insert({
    automation_id: automation.id,
    event: event.type,
    record_uuid: event.uuid,
    status,
    log: JSON.stringify(log),
  });
  if (status !== 'skipped')
    await db('automations')
      .where({ id: automation.id })
      .update({ run_count: db.raw('run_count + 1'), last_run_at: new Date() });
  return { status, log };
});

onEvent(async (e) => {
  if (e.depth >= MAX_DEPTH) return;
  // GDPR Art. 18: a restricted record is stored, not processed.
  if (await eventTouchesRestricted(e)) return;
  const rules = await db('automations')
    .where({ trigger_event: e.type, active: true })
    .select('id', 'delay_minutes');
  for (const r of rules) {
    if (r.delay_minutes > 0)
      await db('automation_queue').insert({
        automation_id: r.id,
        record_uuid: e.uuid,
        event: JSON.stringify(e),
        run_at: new Date(Date.now() + Number(r.delay_minutes) * 60_000),
      });
    else
      await enqueue('automation.run', { automationId: r.id, event: e as unknown as Record<string, unknown> });
  }
});

/** Records a scheduled rule visits per run. */
const SCHEDULE_LIMIT = 500;

/**
 * Release delayed runs that are due, and run scheduled rules whose time has come. Called every
 * minute by the job scheduler (one process at a time with Redis); tests call it directly.
 */
export async function runDueAutomations(now = new Date()) {
  const due = await db('automation_queue').where('run_at', '<=', now).orderBy('run_at').limit(200);
  for (const row of due) {
    // Claim the row first, so two processes never release the same run.
    if (!(await db('automation_queue').where({ id: row.id }).delete())) continue;
    const event = typeof row.event === 'string' ? JSON.parse(row.event) : row.event;
    await enqueue('automation.run', { automationId: row.automation_id, event, recheck: true });
  }
  const { timezone } = await getGroup('general');
  const rules = await db('automations')
    .where({ trigger_event: SCHEDULE_TRIGGER, active: true })
    .where('next_run_at', '<=', now);
  for (const rule of rules) {
    const schedule = (
      typeof rule.schedule === 'string' ? JSON.parse(rule.schedule) : rule.schedule
    ) as AutomationSchedule;
    const claimed = await db('automations')
      .where({ id: rule.id, next_run_at: rule.next_run_at })
      .update({ next_run_at: nextRun(schedule, timezone, now) });
    if (!claimed) continue;
    const def = findRecordDef(schedule.entity);
    if (!def) continue;
    try {
      // Records are those the rule's owner may see, filtered by the rule's conditions.
      const owner = await runAs(rule.created_by);
      const filter = rule.conditions ? JSON.stringify(rule.conditions) : undefined;
      for (let page = 1; page <= SCHEDULE_LIMIT / 100; page++) {
        const list = await listRecords(def, owner, {
          page,
          pageSize: 100,
          ...(filter ? { filter: JSON.parse(filter) } : {}),
        });
        for (const record of list.data as { uuid: string }[]) {
          const event = {
            type: `${schedule.entity}.scheduled`,
            entity: schedule.entity,
            uuid: record.uuid,
            record,
            actorId: null,
            depth: 0,
            at: now.toISOString(),
          };
          await enqueue('automation.run', { automationId: rule.id, event });
        }
        if (page * 100 >= list.meta.total) break;
      }
    } catch (err) {
      logger.warn({ err, automation: rule.uuid }, 'Scheduled automation failed');
      // Visible to admins in the rule's run log.
      await db('automation_runs').insert({
        automation_id: rule.id,
        event: `${schedule.entity}.scheduled`,
        record_uuid: null,
        status: 'failed',
        log: JSON.stringify([(err as Error).message]),
      });
    }
  }
}

/** Started at boot (outside tests). */
export function startAutomationScheduler() {
  every(60_000, 'automations.due', () => runDueAutomations());
}

// ---------- Admin API ----------

const dto = (a: Record<string, unknown>) => ({
  uuid: a.uuid,
  name: a.name,
  description: a.description,
  triggerEvent: a.trigger_event,
  conditions: a.conditions ?? null,
  actions: a.actions,
  delayMinutes: a.delay_minutes ?? 0,
  schedule: a.schedule ?? null,
  nextRunAt: a.next_run_at ? new Date(a.next_run_at as string).toISOString() : null,
  active: !!a.active,
  runCount: a.run_count,
  lastRunAt: a.last_run_at ? new Date(a.last_run_at as string).toISOString() : null,
});

export const automationsRoutes = defineRoutes('/automations', ['automations'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.automations.manage',
    handler: async () => ({
      data: (await db('automations').orderBy('id', 'desc')).map(dto),
      events: [SCHEDULE_TRIGGER, ...eventTypes()],
    }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.automations.manage',
    body: automationBody,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      if (user.apiKeyId) throw new AppError('FORBIDDEN', 'Automations must belong to a person');
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('automations').insert({
          uuid,
          name: body.name,
          description: body.description,
          trigger_event: body.triggerEvent,
          conditions: body.conditions ? JSON.stringify(body.conditions) : null,
          actions: JSON.stringify(body.actions),
          active: body.active,
          delay_minutes: body.delayMinutes,
          schedule: body.schedule ? JSON.stringify(body.schedule) : null,
          next_run_at: body.schedule ? nextRun(body.schedule, (await getGroup('general')).timezone) : null,
          created_by: user.id,
          customized: true,
        });
        await audit(trx, ctx, {
          action: 'automation.created',
          entity: 'automation',
          entityId: id,
          entityUuid: uuid,
          diff: body,
        });
      });
      return dto(await db('automations').where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.automations.manage',
    params: z.object({ uuid: z.uuid() }),
    body: automationPatch,
    handler: async ({ ctx, user, params, body }) => {
      const a = await db('automations').where({ uuid: params.uuid }).first();
      if (!a) throw notFound('Automation');
      if (user.apiKeyId) throw new AppError('FORBIDDEN', 'Automations must belong to a person');
      const schedule =
        body.schedule !== undefined ? body.schedule : (a.schedule as AutomationSchedule | null);
      const trigger = body.triggerEvent ?? (a.trigger_event as string);
      if (!scheduleRule({ triggerEvent: trigger, schedule }))
        throw new AppError('VALIDATION_FAILED', scheduleMessage.message, [
          { path: 'schedule', message: scheduleMessage.message },
        ]);
      const patch: Record<string, unknown> = { customized: true };
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.triggerEvent !== undefined) patch.trigger_event = body.triggerEvent;
      if (body.conditions !== undefined)
        patch.conditions = body.conditions ? JSON.stringify(body.conditions) : null;
      if (body.actions !== undefined) patch.actions = JSON.stringify(body.actions);
      if (body.active !== undefined) patch.active = body.active;
      if (body.delayMinutes !== undefined) patch.delay_minutes = body.delayMinutes;
      // A rule runs with its owner's access. Whoever changes what it does or when becomes the owner,
      // so nobody can borrow someone else's wider scope by editing their rule.
      const substantive = [
        'triggerEvent',
        'conditions',
        'actions',
        'schedule',
        'delayMinutes',
        'active',
      ].some((k) => (body as Record<string, unknown>)[k] !== undefined);
      if (substantive && a.created_by !== user.id) patch.created_by = user.id;
      // Turning a scheduled rule back on starts from the next slot, not from a backlog.
      const reactivated = body.active === true && !a.active;
      if (body.schedule !== undefined || body.triggerEvent !== undefined || reactivated) {
        const sched = typeof schedule === 'string' ? (JSON.parse(schedule) as AutomationSchedule) : schedule;
        patch.schedule = sched ? JSON.stringify(sched) : null;
        patch.next_run_at = sched ? nextRun(sched, (await getGroup('general')).timezone) : null;
      }
      await db.transaction(async (trx) => {
        await trx('automations').where({ id: a.id }).update(patch);
        await audit(trx, ctx, {
          action: 'automation.updated',
          entity: 'automation',
          entityId: a.id,
          entityUuid: params.uuid,
          diff: { ...body, ...(patch.created_by ? { owner: { from: a.created_by, to: user.id } } : {}) },
        });
      });
      return dto(await db('automations').where({ id: a.id }).first());
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.automations.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, params }) => {
      const n = await db('automations').where({ uuid: params.uuid }).delete();
      if (!n) throw notFound('Automation');
      await audit(db, ctx, { action: 'automation.deleted', entity: 'automation', entityUuid: params.uuid });
    },
  })
  .add({
    method: 'get',
    path: '/:uuid/runs',
    permission: 'core.automations.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ params }) => {
      const a = await db('automations').where({ uuid: params.uuid }).first('id');
      if (!a) throw notFound('Automation');
      const rows = await db('automation_runs').where({ automation_id: a.id }).orderBy('id', 'desc').limit(50);
      return {
        data: rows.map((r) => ({
          event: r.event,
          recordUuid: r.record_uuid,
          status: r.status,
          log: r.log,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    },
  });
