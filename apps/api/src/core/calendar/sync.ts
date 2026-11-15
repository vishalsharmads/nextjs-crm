import ICAL from 'ical.js';
import { z } from 'zod';
import { db } from '../../db/knex';
import { defineRoutes } from '../../http/routes';
import { encrypt } from '../../lib/crypto';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { isTest } from '../../config/env';
import { enqueue, every, registerJob } from '../../lib/jobs';
import { logger } from '../../lib/logger';
import { audit } from '../audit/audit.service';
import { onEvent } from '../events/events';
import { assertSafeUrl } from '../webhooks/webhooks';
import { addParticipants, participantsFromAddresses } from '../activities/participants';
import { deleteEvent, fetchEvents, putEvent, verifyCalendar, type CalendarAccount } from './caldav';
import { buildCalendar, plain, uidFor } from './ics';

/**
 * Two-way CalDAV sync (plan 13d). Events whose attendees include known contacts or leads become
 * meetings with participants; meetings in the CRM go to the person's calendar; time and title
 * changes flow both ways, the most recent change winning (D4). Recurring series are only counted
 * as busy time. Busy times feed scheduling links (13e).
 */
const PAST_DAYS = 30;
const AHEAD_DAYS = 180;

interface AccountRow extends CalendarAccount {
  uuid: string;
  display_name: string;
  last_sync_at: Date | null;
  last_error: string | null;
  active: number | boolean;
}

const accountDto = (a: AccountRow) => ({
  uuid: a.uuid,
  url: a.url,
  username: a.username,
  displayName: a.display_name,
  lastSyncAt: a.last_sync_at ? new Date(a.last_sync_at).toISOString() : null,
  lastError: a.last_error,
});

/** Addresses that are the calendar's owner (never a participant). */
async function ownAddresses(account: AccountRow): Promise<string[]> {
  const u = await db('users').where({ id: account.user_id }).first('email');
  const boxes = (await db('mail_accounts').where({ user_id: account.user_id }).pluck('email')) as string[];
  return [u?.email, account.username, ...boxes].filter(Boolean).map((a) => String(a).toLowerCase());
}

export async function syncCalendar(account: AccountRow): Promise<{ logged: number; updated: number }> {
  const from = new Date(Date.now() - PAST_DAYS * 86_400_000);
  const to = new Date(Date.now() + AHEAD_DAYS * 86_400_000);
  const events = await fetchEvents(account, from, to);
  const own = await ownAddresses(account);
  const busy: { starts_at: Date; ends_at: Date }[] = [];
  let logged = 0;
  let updated = 0;
  for (const remote of events) {
    let vevent: ICAL.Component | null;
    try {
      vevent = new ICAL.Component(ICAL.parse(remote.ics)).getFirstSubcomponent('vevent');
    } catch {
      continue;
    }
    if (!vevent) continue;
    const ev = new ICAL.Event(vevent);
    const cancelled = String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
    const free = String(vevent.getFirstPropertyValue('transp') ?? '').toUpperCase() === 'TRANSPARENT';
    if (!cancelled && !free) {
      if (ev.isRecurring()) {
        const it = ev.iterator();
        for (let i = 0, next = it.next(); next && i < 500; i++, next = it.next()) {
          const start = next.toJSDate();
          if (start > to) break;
          const end = new Date(start.getTime() + ev.duration.toSeconds() * 1000);
          if (end >= from) busy.push({ starts_at: start, ends_at: end });
        }
      } else if (ev.startDate) {
        busy.push({ starts_at: ev.startDate.toJSDate(), ends_at: (ev.endDate ?? ev.startDate).toJSDate() });
      }
    }
    if (ev.isRecurring() || !ev.startDate || ev.startDate.isDate) continue;
    const uid = ev.uid;
    const link = await db('calendar_links').where({ account_id: account.id, uid }).first();
    const start = ev.startDate.toJSDate();
    const end = ev.endDate?.toJSDate() ?? new Date(start.getTime() + 3600_000);
    if (link) {
      if (link.etag && remote.etag && link.etag === remote.etag) continue;
      const activity = await db('activities').where({ id: link.activity_id }).first('updated_at');
      const lastModified = vevent.getFirstPropertyValue('last-modified') as ICAL.Time | null;
      const remoteChanged = lastModified ? lastModified.toJSDate() : new Date();
      // Last change wins (D4): an older calendar version does not overwrite a newer CRM edit.
      if (activity && new Date(activity.updated_at) > remoteChanged) {
        await db('calendar_links')
          .where({ id: link.id })
          .update({ etag: remote.etag, synced_at: new Date() });
        continue;
      }
      await db('activities')
        .where({ id: link.activity_id })
        .update({
          subject: (ev.summary || 'Meeting').slice(0, 255),
          start_at: start,
          end_at: end,
          ...(cancelled ? { outcome: 'cancelled' } : {}),
          updated_at: new Date(),
        });
      await db('calendar_links')
        .where({ id: link.id })
        .update({ etag: remote.etag, href: remote.href, synced_at: new Date() });
      updated++;
      continue;
    }
    if (cancelled) continue;
    const addresses = [
      ...vevent.getAllProperties('attendee').map((p) => String(p.getFirstValue() ?? '')),
      String(vevent.getFirstPropertyValue('organizer') ?? ''),
    ]
      .map((a) => a.replace(/^mailto:/i, '').toLowerCase())
      .filter((a) => a.includes('@'));
    const people = await participantsFromAddresses(
      db,
      addresses.map((address) => ({ address, role: 'attendee' as const })),
      own,
    );
    const home = people.find((p) => p.kind === 'contact') ?? people.find((p) => p.kind === 'lead');
    if (!home) continue;
    await db.transaction(async (trx) => {
      const [activityId] = await trx('activities').insert({
        uuid: newUuid(),
        type: 'meeting',
        subject: (ev.summary || 'Meeting').slice(0, 255),
        body: ev.description
          ? `<p>${String(ev.description).replace(/[&<>]/g, ' ').slice(0, 5000)}</p>`
          : null,
        start_at: start,
        end_at: end,
        completed_at: end < new Date() ? end : null,
        owner_id: account.user_id,
        assignee_id: account.user_id,
        related_type: home.kind,
        related_id: home.record_id,
        custom: JSON.stringify({}),
      });
      await addParticipants(trx, activityId!, people);
      await trx('calendar_links').insert({
        account_id: account.id,
        activity_id: activityId,
        uid,
        href: remote.href,
        etag: remote.etag,
      });
    });
    logged++;
  }
  await db.transaction(async (trx) => {
    await trx('calendar_busy').where({ account_id: account.id }).delete();
    for (let i = 0; i < busy.length; i += 500)
      await trx('calendar_busy').insert(
        busy.slice(i, i + 500).map((b) => ({ account_id: account.id, ...b })),
      );
  });
  await db('calendar_accounts')
    .where({ id: account.id })
    .update({ last_sync_at: new Date(), last_error: null });
  return { logged, updated };
}

export async function syncAllCalendars() {
  for (const a of (await db('calendar_accounts').where({ active: true })) as AccountRow[]) {
    await syncCalendar(a).catch(async (err: unknown) => {
      logger.warn({ err, account: a.uuid }, 'Calendar sync failed');
      await db('calendar_accounts')
        .where({ id: a.id })
        .update({
          last_sync_at: new Date(),
          last_error:
            err instanceof AppError
              ? err.message
              : 'The calendar could not be read. Check its address and sign-in.',
        });
    });
  }
}

export const startCalendarSync = () => {
  if (!isTest) every(15 * 60_000, 'calendar-sync', syncAllCalendars);
};

// ---------- CRM → calendar ----------

registerJob('calendar.push', async (job) => {
  const a = await db('activities')
    .where({ id: job.payload.activityId as number })
    .first();
  if (!a || a.type !== 'meeting' || !a.start_at || !a.assignee_id) return;
  const account = (await db('calendar_accounts').where({ user_id: a.assignee_id, active: true }).first()) as
    AccountRow | undefined;
  if (!account) return;
  const link = await db('calendar_links').where({ account_id: account.id, activity_id: a.id }).first();
  if (a.deleted_at) {
    if (link) await deleteEvent(account, link.href as string);
    if (link) await db('calendar_links').where({ id: link.id }).delete();
    return;
  }
  const uid = (link?.uid as string | undefined) ?? uidFor(a.uuid as string);
  const ics = buildCalendar([
    {
      uid,
      sequence: a.ical_sequence as number,
      start: a.start_at as Date,
      end: a.end_at as Date | null,
      summary: a.subject as string,
      description: plain(a.body as string | null).slice(0, 2000) || null,
      status: a.outcome === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
      updated: a.updated_at as Date,
    },
  ]);
  const saved = await putEvent(account, uid, ics, link ? { href: link.href, etag: link.etag } : undefined);
  if (link)
    await db('calendar_links')
      .where({ id: link.id })
      .update({ etag: saved.etag, href: saved.href, synced_at: new Date() });
  else
    await db('calendar_links').insert({
      account_id: account.id,
      activity_id: a.id,
      uid,
      href: saved.href,
      etag: saved.etag,
    });
});

// Meetings saved in the CRM go to the assignee's calendar (sync itself writes without events: no loops).
onEvent(async (e) => {
  if (!['activity.created', 'activity.updated', 'activity.deleted'].includes(e.type)) return;
  const a = await db('activities').where({ uuid: e.uuid }).first('id', 'type', 'assignee_id');
  if (a?.type !== 'meeting' || !a.assignee_id) return;
  if (!(await db('calendar_accounts').where({ user_id: a.assignee_id, active: true }).first('id'))) return;
  await enqueue('calendar.push', { activityId: a.id }).catch((err: unknown) =>
    logger.warn({ err }, 'Calendar push not queued'),
  );
});

// ---------- Routes ----------

const connectBody = z.object({
  url: z.url({ protocol: /^https?$/ }).max(1000),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(500),
});

export const calendarAccountRoutes = defineRoutes('/calendar/accounts', ['calendar'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.activities.view',
    handler: async ({ user }) => ({
      data: ((await db('calendar_accounts').where({ user_id: user.id })) as AccountRow[]).map(accountDto),
    }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.activities.create',
    body: connectBody,
    status: 201,
    summary: 'Connect a CalDAV calendar (checked before saving)',
    handler: async ({ ctx, user, body }) => {
      await assertSafeUrl(body.url, 'url');
      const { displayName } = await verifyCalendar(body.url, body.username, body.password);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        await trx('calendar_accounts').where({ user_id: user.id }).delete();
        await trx('calendar_accounts').insert({
          uuid,
          user_id: user.id,
          url: body.url,
          username: body.username,
          password_enc: encrypt(body.password, 'calendar_accounts.password_enc'),
          display_name: displayName,
        });
        await audit(trx, ctx, {
          action: 'calendar_account.connected',
          entity: 'calendar_account',
          entityUuid: uuid,
          diff: { url: body.url },
        });
      });
      return accountDto((await db('calendar_accounts').where({ uuid }).first()) as AccountRow);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/sync',
    permission: 'core.activities.view',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ user, params }) => {
      const a = (await db('calendar_accounts').where({ uuid: params.uuid, user_id: user.id }).first()) as
        AccountRow | undefined;
      if (!a) throw notFound('Calendar');
      return syncCalendar(a);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.activities.view',
    params: z.object({ uuid: z.uuid() }),
    status: 204,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const n = await trx('calendar_accounts').where({ uuid: params.uuid, user_id: user.id }).delete();
        if (!n) throw notFound('Calendar');
        await audit(trx, ctx, {
          action: 'calendar_account.disconnected',
          entity: 'calendar_account',
          entityUuid: params.uuid,
        });
      });
    },
  });
