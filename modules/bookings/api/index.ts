import { z } from 'zod';
import { toPatch } from '@app/shared';
import {
  AppError,
  assertCan,
  audit,
  db,
  defineRoutes,
  emit,
  getSettingsGroup,
  iso,
  linkRefs,
  newUuid,
  notFound,
  registerModuleWidget,
  resolveLinks,
  userRefs,
  type ApiModule,
  type AuthUser,
  type Db,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_bookings';

const RESOURCES = 'm_bookings_resources';
const BOOKINGS = 'm_bookings_bookings';
const MAX_BOOKING_MS = 31 * 86_400_000;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const resourceBody = z.object({
  name: z.string().trim().min(1).max(150),
  kind: z.string().trim().min(1).max(50).default('room'),
  location: z.string().trim().max(150).default(''),
  capacity: z.coerce.number().int().min(1).max(10_000).nullish(),
  hourlyRate: z.coerce.number().min(0).max(1_000_000).nullish(),
  openTime: hhmm.nullish(),
  closeTime: hhmm.nullish(),
  openDays: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
  position: z.coerce.number().int().default(0),
  active: z.boolean().default(true),
});

const bookingBody = z.object({
  resourceUuid: z.uuid(),
  contactUuid: z.uuid().nullish(),
  organizationUuid: z.uuid().nullish(),
  title: z.string().trim().max(200).default(''),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  attendees: z.coerce.number().int().min(1).max(10_000).nullish(),
  notes: z.string().max(5000).nullish(),
});

const resourceDto = (r: Record<string, unknown>) => ({
  uuid: r.uuid as string,
  name: r.name as string,
  kind: r.kind as string,
  location: r.location as string,
  capacity: (r.capacity as number | null) ?? null,
  hourlyRate: r.hourly_rate === null || r.hourly_rate === undefined ? null : Number(r.hourly_rate),
  openTime: (r.open_time as string | null) ?? null,
  closeTime: (r.close_time as string | null) ?? null,
  openDays: (r.open_days as number[] | null) ?? null,
  position: r.position as number,
  active: !!r.active,
});
type ResourceRow = Record<string, unknown> & { id: number; uuid: string };

async function bookingDtos(rows: Record<string, unknown>[]) {
  const resourceIds = [...new Set(rows.map((r) => r.resource_id as number))];
  const [refs, users, resources] = await Promise.all([
    linkRefs(rows),
    userRefs(rows.map((r) => r.created_by as number | null)),
    resourceIds.length
      ? db(RESOURCES).whereIn('id', resourceIds).select('id', 'uuid', 'name')
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  const byId = new Map(
    resources.map((r) => [r.id as number, { uuid: r.uuid as string, name: r.name as string }]),
  );
  return rows.map((r) => {
    const { contact, organization } = refs(r);
    return {
      uuid: r.uuid as string,
      resource: byId.get(r.resource_id as number)!,
      contact,
      organization,
      title: r.title as string,
      startsAt: iso(r.starts_at)!,
      endsAt: iso(r.ends_at)!,
      attendees: (r.attendees as number | null) ?? null,
      status: r.status as string,
      cancelReason: (r.cancel_reason as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      createdBy: users.get(r.created_by as number) ?? null,
      createdAt: iso(r.created_at)!,
    };
  });
}

/** Local weekday (0 = Sunday), date and HH:MM of an instant in the workspace time zone. */
function localParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    weekday: days.indexOf(parts.weekday!),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** Bookings must start and end on the same open day, inside the resource's opening hours. */
function checkOpeningHours(resource: Record<string, unknown>, start: Date, end: Date, timeZone: string) {
  const open = resource.open_time as string | null;
  const close = resource.close_time as string | null;
  const days = resource.open_days as number[] | null;
  if (!open && !close && !days?.length) return;
  const s = localParts(start, timeZone);
  // An end exactly at midnight belongs to the previous day.
  const e = localParts(new Date(end.getTime() - 1), timeZone);
  const endTime = localParts(end, timeZone).time === '00:00' ? '24:00' : localParts(end, timeZone).time;
  const fail = (message: string) => {
    throw new AppError('VALIDATION_FAILED', message, [{ path: 'startsAt', message }]);
  };
  if (days?.length && !days.includes(s.weekday)) fail(`${resource.name} is closed that day`);
  if ((open || close) && s.date !== e.date)
    fail('Bookings with opening hours must start and end on the same day');
  if (open && s.time < open) fail(`${resource.name} opens at ${open}`);
  if (close && endTime > close) fail(`${resource.name} closes at ${close}`);
}

async function lockResource(trx: Db, uuid: string) {
  const r = await trx(RESOURCES).where({ uuid }).forUpdate().first();
  if (!r)
    throw new AppError('VALIDATION_FAILED', 'Unknown resource', [
      { path: 'resourceUuid', message: 'Not found' },
    ]);
  return r as ResourceRow;
}

/** Overlap: an existing confirmed booking starts before this one ends and ends after it starts. */
async function assertFree(trx: Db, resourceId: number, start: Date, end: Date, ignoreId?: number) {
  const qb = trx(BOOKINGS)
    .where({ resource_id: resourceId, status: 'confirmed' })
    .where('starts_at', '<', end)
    .where('ends_at', '>', start);
  if (ignoreId) qb.whereNot({ id: ignoreId });
  const clash = await qb.first('uuid', 'starts_at', 'ends_at', 'title');
  if (clash)
    throw new AppError('CONFLICT', 'That time overlaps another booking', [
      { path: 'startsAt', message: `Booked ${iso(clash.starts_at)} – ${iso(clash.ends_at)}` },
    ]);
}

function parseRange(startsAt: string, endsAt: string) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (end <= start)
    throw new AppError('VALIDATION_FAILED', 'The end must be after the start', [
      { path: 'endsAt', message: 'Must be after the start' },
    ]);
  if (end.getTime() - start.getTime() > MAX_BOOKING_MS)
    throw new AppError('VALIDATION_FAILED', 'Bookings can last at most 31 days', [
      { path: 'endsAt', message: 'Too long' },
    ]);
  return { start, end };
}

async function emitBooking(
  type: 'booking.created' | 'booking.updated' | 'booking.cancelled',
  uuid: string,
  user: AuthUser,
) {
  const [record] = await bookingDtos([await db(BOOKINGS).where({ uuid }).first()]);
  await emit({
    type,
    entity: 'booking',
    uuid,
    record: record as unknown as Record<string, unknown>,
    actorId: user.id,
  });
}

const uuidParam = z.object({ uuid: z.uuid() });

const resourceRoutes = defineRoutes('/m/bookings/resources', ['bookings'], 'bookings')
  .add({
    method: 'get',
    path: '/',
    permission: 'bookings.bookings.view',
    query: z.object({ all: z.enum(['true', 'false']).default('false') }),
    handler: async ({ query }) => {
      const qb = db(RESOURCES).orderBy(['position', 'name']);
      if (query.all !== 'true') qb.where({ active: true });
      return { data: (await qb).map(resourceDto) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'bookings.resources.manage',
    body: resourceBody,
    status: 201,
    handler: async ({ ctx, body }) => {
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx(RESOURCES).insert({
          uuid,
          name: body.name,
          kind: body.kind,
          location: body.location,
          capacity: body.capacity ?? null,
          hourly_rate: body.hourlyRate ?? null,
          open_time: body.openTime ?? null,
          close_time: body.closeTime ?? null,
          open_days: body.openDays?.length ? JSON.stringify(body.openDays) : null,
          position: body.position,
          active: body.active,
        });
        await audit(trx, ctx, {
          action: 'bookings.resource.created',
          entity: 'bookings.resource',
          entityId: id,
          entityUuid: uuid,
          diff: { name: body.name },
        });
      });
      return resourceDto(await db(RESOURCES).where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'bookings.resources.manage',
    params: uuidParam,
    body: toPatch(resourceBody),
    handler: async ({ ctx, params, body }) => {
      await db.transaction(async (trx) => {
        const r = await trx(RESOURCES).where({ uuid: params.uuid }).forUpdate().first();
        if (!r) throw notFound('Resource');
        const patch: Record<string, unknown> = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.kind !== undefined) patch.kind = body.kind;
        if (body.location !== undefined) patch.location = body.location;
        if (body.capacity !== undefined) patch.capacity = body.capacity;
        if (body.hourlyRate !== undefined) patch.hourly_rate = body.hourlyRate;
        if (body.openTime !== undefined) patch.open_time = body.openTime;
        if (body.closeTime !== undefined) patch.close_time = body.closeTime;
        if (body.openDays !== undefined)
          patch.open_days = body.openDays?.length ? JSON.stringify(body.openDays) : null;
        if (body.position !== undefined) patch.position = body.position;
        if (body.active !== undefined) patch.active = body.active;
        await trx(RESOURCES)
          .where({ id: r.id })
          .update({ ...patch, updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'bookings.resource.updated',
          entity: 'bookings.resource',
          entityId: r.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return resourceDto(await db(RESOURCES).where({ uuid: params.uuid }).first());
    },
  });

const bookingRoutes = defineRoutes('/m/bookings/bookings', ['bookings'], 'bookings')
  .add({
    method: 'get',
    path: '/',
    permission: 'bookings.bookings.view',
    query: z.object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
      resourceUuid: z.uuid().optional(),
      contactUuid: z.uuid().optional(),
      includeCancelled: z.enum(['true', 'false']).default('false'),
    }),
    summary: 'Bookings overlapping a time window (at most 62 days), for calendars and boards.',
    handler: async ({ query }) => {
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (to <= from || to.getTime() - from.getTime() > 62 * 86_400_000)
        throw new AppError('VALIDATION_FAILED', 'Ask for a window of at most 62 days');
      const qb = db(BOOKINGS).where('starts_at', '<', to).where('ends_at', '>', from);
      if (query.includeCancelled !== 'true') qb.where({ status: 'confirmed' });
      if (query.resourceUuid)
        qb.whereIn('resource_id', db(RESOURCES).where({ uuid: query.resourceUuid }).select('id'));
      if (query.contactUuid)
        qb.whereIn('contact_id', db('contacts').where({ uuid: query.contactUuid }).select('id'));
      return { data: await bookingDtos(await qb.orderBy('starts_at').limit(2000)) };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'bookings.bookings.view',
    params: uuidParam,
    handler: async ({ params }) => {
      const row = await db(BOOKINGS).where({ uuid: params.uuid }).first();
      if (!row) throw notFound('Booking');
      return (await bookingDtos([row]))[0];
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'bookings.bookings.create',
    body: bookingBody,
    status: 201,
    summary:
      'Clash-checked: the resource row is locked while checking, so two people cannot take the same slot.',
    handler: async ({ ctx, user, body }) => {
      const { start, end } = parseRange(body.startsAt, body.endsAt);
      const { timezone } = await getSettingsGroup('general');
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const resource = await lockResource(trx, body.resourceUuid);
        if (!resource.active) throw new AppError('CONFLICT', `${resource.name} is not bookable right now`);
        if (body.attendees && resource.capacity && body.attendees > (resource.capacity as number))
          throw new AppError('VALIDATION_FAILED', `${resource.name} fits ${resource.capacity}`, [
            { path: 'attendees', message: `At most ${resource.capacity}` },
          ]);
        checkOpeningHours(resource, start, end, timezone);
        await assertFree(trx, resource.id, start, end);
        const links = await resolveLinks(
          user,
          { contactUuid: body.contactUuid, organizationUuid: body.organizationUuid },
          trx,
        );
        const [id] = await trx(BOOKINGS).insert({
          uuid,
          resource_id: resource.id,
          ...links,
          title: body.title,
          starts_at: start,
          ends_at: end,
          attendees: body.attendees ?? null,
          notes: body.notes ?? null,
          created_by: user.id,
        });
        await audit(trx, ctx, {
          action: 'bookings.booking.created',
          entity: 'bookings.booking',
          entityId: id,
          entityUuid: uuid,
          diff: { resource: resource.name, startsAt: start.toISOString(), endsAt: end.toISOString() },
        });
      });
      await emitBooking('booking.created', uuid, user);
      return (await bookingDtos([await db(BOOKINGS).where({ uuid }).first()]))[0];
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'bookings.bookings.update',
    params: uuidParam,
    body: toPatch(bookingBody),
    summary: 'Move or edit a booking. Moves are clash-checked like new bookings.',
    handler: async ({ ctx, user, params, body }) => {
      const { timezone } = await getSettingsGroup('general');
      await db.transaction(async (trx) => {
        const row = await trx(BOOKINGS).where({ uuid: params.uuid }).forUpdate().first();
        if (!row) throw notFound('Booking');
        if (row.status !== 'confirmed')
          throw new AppError('CONFLICT', 'Cancelled bookings cannot be changed');
        const resource = body.resourceUuid
          ? await lockResource(trx, body.resourceUuid)
          : ((await trx(RESOURCES).where({ id: row.resource_id }).forUpdate().first()) as ResourceRow);
        const { start, end } = parseRange(
          body.startsAt ?? new Date(row.starts_at).toISOString(),
          body.endsAt ?? new Date(row.ends_at).toISOString(),
        );
        const attendees = body.attendees === undefined ? row.attendees : body.attendees;
        if (attendees && resource.capacity && attendees > (resource.capacity as number))
          throw new AppError('VALIDATION_FAILED', `${resource.name} fits ${resource.capacity}`, [
            { path: 'attendees', message: `At most ${resource.capacity}` },
          ]);
        checkOpeningHours(resource, start, end, timezone);
        await assertFree(trx, resource.id, start, end, row.id);
        const links = await resolveLinks(
          user,
          { contactUuid: body.contactUuid, organizationUuid: body.organizationUuid },
          trx,
        );
        const patch: Record<string, unknown> = {
          ...links,
          resource_id: resource.id,
          starts_at: start,
          ends_at: end,
          attendees: attendees ?? null,
          updated_at: new Date(),
        };
        if (body.title !== undefined) patch.title = body.title;
        if (body.notes !== undefined) patch.notes = body.notes;
        await trx(BOOKINGS).where({ id: row.id }).update(patch);
        await audit(trx, ctx, {
          action: 'bookings.booking.updated',
          entity: 'bookings.booking',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      await emitBooking('booking.updated', params.uuid, user);
      return (await bookingDtos([await db(BOOKINGS).where({ uuid: params.uuid }).first()]))[0];
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/cancel',
    permission: 'bookings.bookings.delete',
    params: uuidParam,
    body: z.object({ reason: z.string().trim().max(500).nullish() }),
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await trx(BOOKINGS).where({ uuid: params.uuid }).forUpdate().first();
        if (!row) throw notFound('Booking');
        if (row.status === 'cancelled') throw new AppError('CONFLICT', 'This booking is already cancelled');
        await trx(BOOKINGS)
          .where({ id: row.id })
          .update({ status: 'cancelled', cancel_reason: body.reason ?? null, updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'bookings.booking.cancelled',
          entity: 'bookings.booking',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { reason: body.reason ?? null },
        });
      });
      await emitBooking('booking.cancelled', params.uuid, user);
      return (await bookingDtos([await db(BOOKINGS).where({ uuid: params.uuid }).first()]))[0];
    },
  });

/** Right now: how many active resources are in use, and how many bookings today (workspace time zone). */
registerModuleWidget('bookings.occupancy', async (_params, user) => {
  assertCan(user, 'bookings.bookings.view');
  const { timezone } = await getSettingsGroup('general');
  const now = new Date();
  const today = localParts(now, timezone).date;
  const total = Number(
    ((await db(RESOURCES).where({ active: true }).count({ c: '*' }).first()) as { c: number }).c,
  );
  const inUse = Number(
    (
      (await db(BOOKINGS)
        .where({ status: 'confirmed' })
        .where('starts_at', '<=', now)
        .where('ends_at', '>', now)
        .countDistinct({ c: 'resource_id' })
        .first()) as { c: number }
    ).c,
  );
  // A day window wide enough for any time zone, then filtered to the local date.
  const around = await db(BOOKINGS)
    .where({ status: 'confirmed' })
    .whereBetween('starts_at', [
      new Date(now.getTime() - 36 * 3_600_000),
      new Date(now.getTime() + 36 * 3_600_000),
    ])
    .select('starts_at');
  const bookingsToday = around.filter(
    (b) => localParts(new Date(b.starts_at), timezone).date === today,
  ).length;
  return { inUse, total, bookingsToday };
});

export const bookings: ApiModule = {
  routes: () => [resourceRoutes, bookingRoutes],
  migrations: { '0001_bookings': m0001 },
};
export { checkOpeningHours, localParts };
