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
import { createRecord, deleteRecord } from '../records/service';
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
      try {
        new Intl.DateTimeFormat('en', { timeZone: body.timeZone });
      } catch {
        throw new AppError('VALIDATION_FAILED', 'Unknown time zone', [
          { path: 'timeZone', message: 'Unknown' },
        ]);
      }
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

async function book(ctx: RequestContext, slug: string, input: z.output<typeof bookBody>) {
  const { page, host } = await livePage(slug);
  const type = page.meeting_types.find((t) => t.key === input.type);
  if (!type) throw notFound('Meeting type');
  for (const q of type.questions)
    if (q.required && !input.answers[q.key]?.trim())
      throw new AppError('VALIDATION_FAILED', `Please answer: ${q.label}`, [
        { path: `answers.${q.key}`, message: 'Required' },
      ]);
  const start = new Date(input.start);
  // The slot must still be free (another visitor may have taken it).
  const free = await slotsFor(page, type);
  if (!free.some((s) => s.getTime() === start.getTime()))
    throw new AppError('CONFLICT', 'That time is no longer available. Choose another.');

  const email = input.email.toLowerCase();
  // An existing contact or lead the host can see, else a new lead (like a web form).
  const known = await visibleTo(
    host.id,
    await participantsFromAddresses(db, [{ address: email, role: 'attendee' }], [host.email]),
  );
  let person = known.find((p) => p.kind === 'contact') ?? known.find((p) => p.kind === 'lead');
  const { leads } = await getGroup('features');
  // Someone whose processing is restricted is never added again as a new record: the meeting is
  // still booked, with them in its notes only.
  const restricted = (await restrictedRecipients([email])) > 0;
  if (!person && !restricted) {
    const [first, ...rest] = input.name.split(/\s+/);
    try {
      const def = leads ? recordDefs.lead : recordDefs.contact;
      const created = (await createRecord(def, ctx, host, {
        firstName: first,
        lastName: rest.join(' '),
        email,
        source: 'Booking',
        ownerUuid: host.uuid,
      })) as { uuid: string };
      const row = await db(def.table).where({ uuid: created.uuid }).first('id');
      person = { kind: leads ? 'lead' : 'contact', record_id: row.id as number, role: 'attendee' };
    } catch (err) {
      // A duplicate rule may refuse a new record: the meeting is still booked, with the visitor in its notes.
      logger.warn({ err: (err as Error).message }, 'Booking could not create a record for the visitor');
    }
  }
  const personUuid = person
    ? ((
        await db(person.kind === 'lead' ? 'leads' : 'contacts')
          .where({ id: person.record_id })
          .first('uuid')
      )?.uuid as string)
    : null;
  const details = [
    `<p>Booked through ${escapeHtml(page.title)} by ${escapeHtml(input.name)} (${escapeHtml(email)}).</p>`,
    ...type.questions
      .filter((q) => input.answers[q.key])
      .map((q) => `<p><strong>${escapeHtml(q.label)}</strong><br>${escapeHtml(input.answers[q.key]!)}</p>`),
  ].join('');
  const meeting = (await createRecord(recordDefs.activity, ctx, host, {
    type: 'meeting',
    subject: `${type.name}: ${input.name}`.slice(0, 255),
    body: details,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + type.durationMin * 60_000).toISOString(),
    assigneeUuid: host.uuid,
    ...(person && personUuid
      ? {
          related: { type: person.kind as 'contact' | 'lead', uuid: personUuid },
          participants: [{ kind: person.kind as 'contact' | 'lead', uuid: personUuid }],
          invite: true,
        }
      : {}),
  })) as { uuid: string };
  const activity = await db('activities').where({ uuid: meeting.uuid }).first('id');
  const token = randomBytes(32).toString('base64url');
  await db('bookings').insert({
    page_id: page.id,
    activity_id: activity.id,
    type_key: type.key,
    token_hash: hash(token),
    visitor_name: input.name,
    visitor_email: email,
    answers: JSON.stringify(input.answers),
  });
  await emit({
    type: 'meeting.booked',
    entity: 'activity',
    uuid: meeting.uuid,
    record: { uuid: meeting.uuid, type: type.key, start: start.toISOString() },
    actorId: host.id,
  });
  const app = new URL(env.APP_URL);
  return {
    start: start.toISOString(),
    manageUrl: `${app.origin}${app.pathname.replace(/\/$/, '')}/book/manage/${token}`,
  };
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
      const page = (await db('booking_pages').where({ id: b.page_id }).first()) as PageRow;
      const host = await owner(page.user_id);
      const activity = await db('activities')
        .where({ id: b.activity_id })
        .whereNull('deleted_at')
        .first('uuid');
      await db('bookings').where({ id: b.id }).update({ cancelled_at: new Date() });
      if (host && activity)
        await deleteRecord(recordDefs.activity, ctx, { ...host, isAdmin: true }, activity.uuid as string);
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
