import { createHash, randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  bookingPageSchema,
  computeSlots,
  type BookingPageInput,
  type Interval,
  type MeetingType,
} from '@app/shared';
import { env, isTest } from '../../config/env';
import { db } from '../../db/knex';
import { defineRoutes } from '../../http/routes';
import type { AuthUser, RequestContext } from '../../http/context';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { logger } from '../../lib/logger';
import { audit } from '../audit/audit.service';
import { emit } from '../events/events';
import { can, loadAccess } from '../rbac/access';
import { createRecord, emitRecordEvent } from '../records/service';
import { recordDefs } from '../records/registry';
import { participantsFromAddresses, visibleTo } from '../activities/participants';
import { getGroup } from '../settings/settings.service';
import { restrictedRecipients } from '../privacy/privacy.service';

/**
 * Scheduling links (plan 13e). A person publishes a page with meeting types and working hours;
 * visitors pick a free slot (working hours minus CRM meetings and calendar busy times) and book.
 * The booking becomes a meeting with the visitor as participant (an existing contact or lead the
 * owner can see, or a new lead created like a web form does), with an invitation and a link to
 * cancel. Public routes are rate limited and reveal nothing but the free times.
 */
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

interface PageRow {
  id: number;
  uuid: string;
  user_id: number;
  slug: string;
  title: string;
  intro: string | null;
  time_zone: string;
  hours: BookingPageInput['hours'];
  meeting_types: MeetingType[];
  active: number | boolean;
}

const pageDto = (p: PageRow) => ({
  slug: p.slug,
  title: p.title,
  intro: p.intro ?? '',
  timeZone: p.time_zone,
  hours: p.hours,
  meetingTypes: p.meeting_types,
  active: !!p.active,
});

/** The page owner as the access checks see them (bookings are created as the owner). */
async function owner(userId: number): Promise<AuthUser | null> {
  const u = await db('users').where({ id: userId, status: 'active' }).whereNull('deleted_at').first();
  if (!u) return null;
  return {
    id: u.id,
    uuid: u.uuid,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    sessionId: null,
    ...(await loadAccess(u.id)),
    // A visitor supplies the values, as with web forms.
    via: 'form',
  };
}

/** Busy time of the owner: their meetings in the CRM (held or attended) and calendar busy times. */
async function busyOf(userId: number, from: Date, to: Date): Promise<Interval[]> {
  const meetings = await db('activities')
    .whereNull('deleted_at')
    .where('type', 'meeting')
    // NOT (outcome = 'cancelled') would also drop meetings without an outcome (NULL).
    .where((w) => w.whereNull('outcome').orWhereNot('outcome', 'cancelled'))
    .where('start_at', '<', to)
    .where((w) => w.where('end_at', '>', from).orWhereNull('end_at'))
    .where((w) =>
      w
        .where('assignee_id', userId)
        .orWhereExists((e) =>
          e
            .select(db.raw('1'))
            .from('activity_participants as ap')
            .whereRaw('ap.activity_id = activities.id')
            .where({ 'ap.kind': 'user', 'ap.record_id': userId }),
        ),
    )
    .select('start_at', 'end_at');
  const calendar = await db('calendar_busy as b')
    .join('calendar_accounts as a', 'a.id', 'b.account_id')
    .where('a.user_id', userId)
    .where('b.starts_at', '<', to)
    .where('b.ends_at', '>', from)
    .select('b.starts_at', 'b.ends_at');
  return [
    ...meetings.map((m) => ({
      start: new Date(m.start_at),
      end: new Date(m.end_at ?? new Date(new Date(m.start_at).getTime() + 3600_000)),
    })),
    ...calendar.map((c) => ({ start: new Date(c.starts_at), end: new Date(c.ends_at) })),
  ];
}

async function slotsFor(page: PageRow, type: MeetingType, now = new Date()) {
  const busy = await busyOf(page.user_id, now, new Date(now.getTime() + (type.horizonDays + 1) * 86_400_000));
  return computeSlots({ hours: page.hours, timeZone: page.time_zone, type, busy, now });
}

async function livePage(slug: string): Promise<{ page: PageRow; host: AuthUser }> {
  const page = (await db('booking_pages').where({ slug, active: true }).first()) as PageRow | undefined;
  const host = page ? await owner(page.user_id) : null;
  if (!page || !host || !can(host, 'core.activities.create')) throw notFound('Booking page');
  return { page, host };
}

const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 1000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: () => {
    throw new AppError('RATE_LIMITED', 'Too many requests. Try again in a minute.');
  },
});
const bookLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 1000 : 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: () => {
    throw new AppError('RATE_LIMITED', 'Too many bookings. Try again in a minute.');
  },
});

// ---------- The owner's settings ----------

export const bookingPageRoutes = defineRoutes('/me/booking-page', ['me'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.activities.create',
    handler: async ({ user }) => {
      const p = (await db('booking_pages').where({ user_id: user.id }).first()) as PageRow | undefined;
      return { page: p ? pageDto(p) : null };
    },
  })
  .add({
    method: 'put',
    path: '/',
    permission: 'core.activities.create',
    body: bookingPageSchema,
    summary: 'Create or change your booking page',
    handler: async ({ ctx, user, body }) => {
      // A named zone with daylight-saving rules (not a fixed offset such as +05:30).
      if (!Intl.supportedValuesOf('timeZone').includes(body.timeZone) && body.timeZone !== 'UTC')
        throw new AppError('VALIDATION_FAILED', 'Unknown time zone', [
          { path: 'timeZone', message: 'Unknown' },
        ]);
      const keys = body.meetingTypes.map((t) => t.key);
      if (new Set(keys).size !== keys.length)
        throw new AppError('VALIDATION_FAILED', 'Meeting types need different keys', [
          { path: 'meetingTypes', message: 'Duplicate' },
        ]);
      const taken = await db('booking_pages')
        .where({ slug: body.slug })
        .whereNot({ user_id: user.id })
        .first('id');
      if (taken)
        throw new AppError('CONFLICT', 'That address is taken. Choose another.', [
          { path: 'slug', message: 'Taken' },
        ]);
      await db.transaction(async (trx) => {
        const values = {
          slug: body.slug,
          title: body.title,
          intro: body.intro,
          time_zone: body.timeZone,
          hours: JSON.stringify(body.hours),
          meeting_types: JSON.stringify(body.meetingTypes),
          active: body.active,
          updated_at: new Date(),
        };
        await trx('booking_pages')
          .insert({ uuid: newUuid(), user_id: user.id, ...values })
          .onConflict('user_id')
          .merge(Object.keys(values));
        await audit(trx, ctx, {
          action: 'booking_page.saved',
          entity: 'user',
          entityId: user.id,
          diff: { slug: body.slug, active: body.active },
        });
      });
      return { page: pageDto((await db('booking_pages').where({ user_id: user.id }).first()) as PageRow) };
    },
  })
  .add({
    method: 'delete',
    path: '/',
    permission: 'core.activities.create',
    status: 204,
    handler: async ({ ctx, user }) => {
      await db.transaction(async (trx) => {
        await trx('booking_pages').where({ user_id: user.id }).delete();
        await audit(trx, ctx, { action: 'booking_page.removed', entity: 'user', entityId: user.id });
      });
    },
  });

// ---------- Public ----------

const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,59}$/) });
const bookBody = z.object({
  type: z.string().max(40),
  start: z.iso.datetime(),
  name: z.string().trim().min(1).max(200),
  email: z.email().max(255),
  answers: z.record(z.string().max(40), z.string().max(2000)).default({}),
  /** Honeypot: people never fill it in. */
  website: z.string().max(200).optional(),
});

/** Open future bookings one visitor may hold on one page, and bookings a page takes per day. */
const PER_EMAIL = 3;
const PER_DAY = 50;
// Control characters (line breaks included) never reach a subject or an invitation.
const clean = (s: string) => s.replace(/\p{Cc}+/gu, ' ').trim();

async function book(ctx: RequestContext, slug: string, input: z.output<typeof bookBody>) {
  const { page, host } = await livePage(slug);
  const type = page.meeting_types.find((t) => t.key === input.type);
  if (!type) throw notFound('Meeting type');
  for (const q of type.questions)
    if (q.required && !input.answers[q.key]?.trim())
      throw new AppError('VALIDATION_FAILED', `Please answer: ${q.label}`, [
        { path: `answers.${q.key}`, message: 'Required' },
      ]);
  // Only the page's own questions are kept.
  const answers = Object.fromEntries(
    type.questions
      .filter((q) => input.answers[q.key]?.trim())
      .map((q) => [q.key, input.answers[q.key]!.trim()]),
  );
  const name = clean(input.name).slice(0, 200) || 'Visitor';
  const email = input.email.toLowerCase();
  const start = new Date(input.start);
  // Written as the page owner through a booking page, so the audit trail says where it came from.
  const actorCtx: RequestContext = { ...ctx, user: host };
  const token = randomBytes(32).toString('base64url');

  const done = await db.transaction(async (trx) => {
    // One booking at a time per page: the next visitor waits, then sees this one's meeting as busy.
    await trx('booking_pages').where({ id: page.id }).forUpdate().first('id');
    const open = await trx('bookings as b')
      .join('activities as a', 'a.id', 'b.activity_id')
      .where({ 'b.page_id': page.id, 'b.visitor_email': email })
      .whereNull('b.cancelled_at')
      .whereNull('a.deleted_at')
      .where('a.start_at', '>', new Date())
      .count({ c: '*' })
      .first();
    if (Number((open as { c: number }).c) >= PER_EMAIL)
      throw new AppError(
        'RATE_LIMITED',
        'You already have bookings coming up. Cancel one before booking another.',
      );
    const today = await trx('bookings')
      .where({ page_id: page.id })
      .where('created_at', '>', new Date(Date.now() - 86_400_000))
      .count({ c: '*' })
      .first();
    if (Number((today as { c: number }).c) >= PER_DAY)
      throw new AppError('RATE_LIMITED', 'This page is not taking more bookings today. Try again tomorrow.');
    // The slot must still be free (checked under the page lock).
    if (!(await slotIsFree(page, type, start)))
      throw new AppError('CONFLICT', 'That time is no longer available. Choose another.');

    // An existing contact or lead the host can see (never a restricted one), else a new lead.
    const known = await visibleTo(
      host.id,
      await participantsFromAddresses(trx, [{ address: email, role: 'attendee' }], [host.email]),
    );
    let person = known.find((p) => p.kind === 'contact') ?? known.find((p) => p.kind === 'lead');
    let createdPerson: { entity: 'lead' | 'contact'; dto: Record<string, unknown> } | null = null;
    const { leads } = await getGroup('features');
    const restricted = (await restrictedRecipients([email], trx)) > 0;
    if (!person && !restricted) {
      const [first, ...rest] = name.split(/\s+/);
      const entity = leads ? ('lead' as const) : ('contact' as const);
      try {
        const created = (await createRecord(
          recordDefs[entity],
          actorCtx,
          host,
          { firstName: first, lastName: rest.join(' '), email, source: 'Booking', ownerUuid: host.uuid },
          trx,
        )) as Record<string, unknown> & { uuid: string };
        const row = await trx(recordDefs[entity].table).where({ uuid: created.uuid }).first('id');
        person = { kind: entity, record_id: row.id as number, role: 'attendee' };
        createdPerson = { entity, dto: created };
      } catch (err) {
        // A duplicate rule may refuse a new record: the meeting is still booked, with the visitor in its notes.
        if (!(err instanceof AppError)) throw err;
        logger.warn({ err: err.message }, 'Booking could not create a record for the visitor');
      }
    }
    const personUuid = person
      ? ((
          await trx(person.kind === 'lead' ? 'leads' : 'contacts')
            .where({ id: person.record_id })
            .first('uuid')
        )?.uuid as string)
      : null;
    const details = [
      `<p>Booked through ${escapeHtml(page.title)} by ${escapeHtml(name)} (${escapeHtml(email)}).</p>`,
      ...type.questions
        .filter((q) => answers[q.key])
        .map((q) => `<p><strong>${escapeHtml(q.label)}</strong><br>${escapeHtml(answers[q.key]!)}</p>`),
    ].join('');
    const meeting = (await createRecord(
      recordDefs.activity,
      actorCtx,
      host,
      {
        type: 'meeting',
        subject: `${type.name}: ${name}`.slice(0, 255),
        body: details,
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + type.durationMin * 60_000).toISOString(),
        assigneeUuid: host.uuid,
        // The invitation goes only to the record with the email the visitor typed.
        ...(person && personUuid
          ? {
              related: { type: person.kind as 'contact' | 'lead', uuid: personUuid },
              participants: [{ kind: person.kind as 'contact' | 'lead', uuid: personUuid }],
              invite: true,
            }
          : {}),
      },
      trx,
    )) as Record<string, unknown> & { uuid: string };
    const activity = await trx('activities').where({ uuid: meeting.uuid }).first('id');
    await trx('bookings').insert({
      page_id: page.id,
      activity_id: activity.id,
      type_key: type.key,
      token_hash: hash(token),
      visitor_name: name,
      visitor_email: email,
      answers: JSON.stringify(answers),
    });
    await audit(trx, actorCtx, {
      action: 'meeting.booked',
      entity: 'activity',
      entityId: activity.id as number,
      entityUuid: meeting.uuid,
      diff: { page: page.slug, type: type.key, start: start.toISOString() },
    });
    return { meeting, createdPerson };
  });

  // After commit: the usual events (webhooks, automations, the invitation).
  if (done.createdPerson)
    await emitRecordEvent(recordDefs[done.createdPerson.entity], 'created', done.createdPerson.dto, host);
  await emitRecordEvent(recordDefs.activity, 'created', done.meeting, host);
  await emit({
    type: 'meeting.booked',
    entity: 'activity',
    uuid: done.meeting.uuid,
    record: { uuid: done.meeting.uuid, type: type.key, start: start.toISOString() },
    actorId: host.id,
  });
  const app = new URL(env.APP_URL);
  return {
    start: start.toISOString(),
    manageUrl: `${app.origin}${app.pathname.replace(/\/$/, '')}/book/manage/${token}`,
  };
}

/** Is one start time free? Computes only around that day, not the whole horizon. */
async function slotIsFree(page: PageRow, type: MeetingType, start: Date, now = new Date()) {
  if (Number.isNaN(start.getTime())) return false;
  const busy = await busyOf(
    page.user_id,
    new Date(start.getTime() - 86_400_000),
    new Date(start.getTime() + 2 * 86_400_000),
  );
  return computeSlots({ hours: page.hours, timeZone: page.time_zone, type, busy, now }).some(
    (s) => s.getTime() === start.getTime(),
  );
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const publicBookingRoutes = defineRoutes('/public/book', ['public'])
  .add({
    method: 'get',
    path: '/manage/:token',
    permission: 'public',
    before: [publicLimiter],
    params: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
    summary: 'A booking, for the visitor who made it (from the link in their invitation)',
    handler: async ({ params }) => {
      const b = await db('bookings as b')
        .join('activities as a', 'a.id', 'b.activity_id')
        .join('booking_pages as p', 'p.id', 'b.page_id')
        .where('b.token_hash', hash(params.token))
        .first(
          'a.start_at',
          'a.end_at',
          'a.deleted_at',
          'b.cancelled_at',
          'b.type_key',
          'p.slug',
          'p.title',
          'p.meeting_types',
        );
      if (!b) throw notFound('Booking');
      const type = (b.meeting_types as MeetingType[]).find((t) => t.key === b.type_key);
      return {
        title: b.title as string,
        slug: b.slug as string,
        type: type?.name ?? '',
        start: new Date(b.start_at).toISOString(),
        end: b.end_at ? new Date(b.end_at).toISOString() : null,
        cancelled: !!b.cancelled_at || !!b.deleted_at,
      };
    },
  })
  .add({
    method: 'post',
    path: '/manage/:token/cancel',
    permission: 'public',
    before: [publicLimiter],
    params: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
    status: 204,
    summary: 'Cancel a booking (the meeting is removed and the host told)',
    handler: async ({ ctx, params }) => {
      const b = await db('bookings')
        .where({ token_hash: hash(params.token) })
        .whereNull('cancelled_at')
        .first();
      if (!b) throw notFound('Booking');
      const activity = await db('activities')
        .where({ id: b.activity_id })
        .whereNull('deleted_at')
        .first('id', 'uuid', 'start_at');
      if (activity && new Date(activity.start_at) <= new Date())
        throw new AppError(
          'VALIDATION_FAILED',
          'This meeting has already started and can no longer be cancelled here.',
        );
      const page = (await db('booking_pages').where({ id: b.page_id }).first()) as PageRow;
      const host = await owner(page.user_id);
      const actorCtx: RequestContext = { ...ctx, user: host };
      // The booking and its meeting go together, or neither does (no elevated rights needed).
      await db.transaction(async (trx) => {
        await trx('bookings').where({ id: b.id }).update({ cancelled_at: new Date() });
        if (activity) {
          await trx('activities').where({ id: activity.id }).update({ deleted_at: new Date() });
          await audit(trx, actorCtx, {
            action: 'activity.deleted',
            entity: 'activity',
            entityId: activity.id as number,
            entityUuid: activity.uuid as string,
            diff: { cancelledBy: 'visitor', booking: true },
          });
        }
      });
      // The invitation's cancellation and the host's calendar follow the usual deleted event.
      if (activity && host)
        await emitRecordEvent(recordDefs.activity, 'deleted', { uuid: activity.uuid as string }, host);
    },
  })
  .add({
    method: 'get',
    path: '/:slug',
    permission: 'public',
    before: [publicLimiter],
    params: slugParam,
    summary: 'A booking page: its title, introduction and meeting types',
    handler: async ({ params }) => {
      const { page, host } = await livePage(params.slug);
      return {
        title: page.title,
        intro: page.intro ?? '',
        host: `${host.firstName} ${host.lastName}`.trim(),
        timeZone: page.time_zone,
        meetingTypes: page.meeting_types.map((t) => ({
          key: t.key,
          name: t.name,
          durationMin: t.durationMin,
          questions: t.questions,
        })),
      };
    },
  })
  .add({
    method: 'get',
    path: '/:slug/slots',
    permission: 'public',
    before: [publicLimiter],
    params: slugParam,
    query: z.object({ type: z.string().max(40) }),
    summary: 'Free start times for one meeting type (only times, nothing about other meetings)',
    handler: async ({ params, query }) => {
      const { page } = await livePage(params.slug);
      const type = page.meeting_types.find((t) => t.key === query.type);
      if (!type) throw notFound('Meeting type');
      return { slots: (await slotsFor(page, type)).map((d) => d.toISOString()) };
    },
  })
  .add({
    method: 'post',
    path: '/:slug',
    permission: 'public',
    before: [bookLimiter],
    params: slugParam,
    body: bookBody,
    status: 201,
    summary: 'Book a meeting',
    handler: async ({ ctx, params, body }) => {
      // Bots fill in every field: answer as if booked, book nothing.
      if (body.website) return { start: body.start, manageUrl: null };
      return book(ctx, params.slug, body);
    },
  });
