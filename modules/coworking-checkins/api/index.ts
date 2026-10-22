import { z } from 'zod';
import {
  AppError,
  assertCan,
  audit,
  db,
  defineRoutes,
  getBranding,
  getSettingsGroup,
  iso,
  logger,
  newUuid,
  notFound,
  registerModuleWidget,
  resolveLinks,
  sendMail,
  todayIn,
  userRefs,
  type ApiModule,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_checkins';

const VISITS = 'm_coworking_checkins_visits';

async function dtos(rows: Record<string, unknown>[]) {
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.contact_id, r.host_contact_id])
        .filter((v): v is number => typeof v === 'number'),
    ),
  ];
  const contacts = ids.length
    ? new Map(
        (await db('contacts').whereIn('id', ids).select('id', 'uuid', 'full_name')).map((c) => [
          c.id as number,
          { uuid: c.uuid as string, name: c.full_name as string },
        ]),
      )
    : new Map<number, { uuid: string; name: string }>();
  const users = await userRefs(rows.map((r) => r.checked_in_by as number | null));
  return rows.map((r) => ({
    uuid: r.uuid as string,
    kind: r.kind as 'member' | 'visitor',
    member: contacts.get(r.contact_id as number) ?? null,
    host: contacts.get(r.host_contact_id as number) ?? null,
    visitorName: (r.visitor_name as string | null) ?? null,
    visitorCompany: (r.visitor_company as string | null) ?? null,
    purpose: (r.purpose as string | null) ?? null,
    badge: (r.badge as string | null) ?? null,
    checkedInAt: iso(r.checked_in_at)!,
    checkedOutAt: iso(r.checked_out_at),
    hostNotified: !!r.host_notified,
    checkedInBy: users.get(r.checked_in_by as number) ?? null,
  }));
}

/** Start of today in the workspace time zone, as a UTC instant (for "today's visits"). */
async function startOfToday() {
  const { timezone } = await getSettingsGroup('general');
  const today = todayIn(timezone);
  // Find the UTC instant whose local date first equals `today` (the zone offset is within ±14h).
  const guess = new Date(`${today}T00:00:00Z`);
  for (let h = -14; h <= 14; h++) {
    const at = new Date(guess.getTime() + h * 3_600_000);
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    if (local.startsWith(today) && local.endsWith(', 00')) return at;
  }
  return guess;
}

async function tellHost(hostContactId: number, visitorName: string, company: string | null) {
  const host = await db('contacts')
    .where({ id: hostContactId })
    .whereNull('deleted_at')
    .first('email', 'first_name');
  if (!host?.email) return false;
  const branding = await getBranding();
  const who = company ? `${visitorName} (${company})` : visitorName;
  try {
    await sendMail({
      to: host.email as string,
      subject: `${visitorName.replace(/[\r\n]+/g, ' ')} has arrived`,
      html: `<p>Hi ${String(host.first_name ?? '').replace(/[<>&"]/g, '')},</p><p>Your guest ${who.replace(/[<>&"]/g, '')} is waiting at reception.</p>`,
      text: `Hi ${host.first_name ?? ''},\n\nYour guest ${who} is waiting at reception.`,
      fromName: branding.emailFromName || branding.appName,
      fromAddress: branding.emailFromAddress || undefined,
    });
    return true;
  } catch (err) {
    logger.warn({ err }, 'Could not email the host about their guest');
    return false;
  }
}

const routes = defineRoutes('/m/coworking-checkins/visits', ['coworking-checkins'], 'coworking-checkins')
  .add({
    method: 'get',
    path: '/',
    permission: 'coworking-checkins.checkins.view',
    query: z.object({ scope: z.enum(['in', 'today']).default('in') }),
    summary: '`in`: everyone checked in and not out. `today`: every visit since local midnight.',
    handler: async ({ query }) => {
      const qb = db(VISITS);
      if (query.scope === 'in') qb.whereNull('checked_out_at');
      else qb.where('checked_in_at', '>=', await startOfToday());
      return { data: await dtos(await qb.orderBy('checked_in_at', 'desc').limit(1000)) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'coworking-checkins.checkins.manage',
    body: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('member'),
        contactUuid: z.uuid(),
        badge: z.string().trim().max(50).nullish(),
      }),
      z.object({
        kind: z.literal('visitor'),
        visitorName: z.string().trim().min(1).max(200),
        visitorCompany: z.string().trim().max(200).nullish(),
        visitorEmail: z.union([z.email().max(254), z.literal('')]).nullish(),
        hostUuid: z.uuid().nullish(),
        purpose: z.string().trim().max(300).nullish(),
        badge: z.string().trim().max(50).nullish(),
        notifyHost: z.boolean().default(true),
      }),
    ]),
    status: 201,
    summary: 'Check a member or a visitor in. Visitors can notify their host by email.',
    handler: async ({ ctx, user, body }) => {
      const uuid = newUuid();
      let hostId: number | null = null;
      await db.transaction(async (trx) => {
        if (body.kind === 'member') {
          const { contact_id } = await resolveLinks(user, { contactUuid: body.contactUuid }, trx);
          const already = await trx(VISITS)
            .where({ contact_id, kind: 'member' })
            .whereNull('checked_out_at')
            .first('id');
          if (already) throw new AppError('CONFLICT', 'Already checked in');
          await trx(VISITS).insert({
            uuid,
            kind: 'member',
            contact_id,
            badge: body.badge ?? null,
            checked_in_at: new Date(),
            checked_in_by: user.id,
          });
        } else {
          hostId = body.hostUuid
            ? ((await resolveLinks(user, { contactUuid: body.hostUuid }, trx)).contact_id ?? null)
            : null;
          await trx(VISITS).insert({
            uuid,
            kind: 'visitor',
            host_contact_id: hostId,
            visitor_name: body.visitorName,
            visitor_company: body.visitorCompany ?? null,
            visitor_email: body.visitorEmail || null,
            purpose: body.purpose ?? null,
            badge: body.badge ?? null,
            checked_in_at: new Date(),
            checked_in_by: user.id,
          });
        }
        await audit(trx, ctx, {
          action: 'coworking-checkins.checked_in',
          entity: 'coworking-checkins.visit',
          entityUuid: uuid,
          diff: { kind: body.kind },
        });
      });
      if (body.kind === 'visitor' && body.notifyHost && hostId) {
        const sent = await tellHost(hostId, body.visitorName, body.visitorCompany ?? null);
        if (sent) await db(VISITS).where({ uuid }).update({ host_notified: true });
      }
      return (await dtos([await db(VISITS).where({ uuid }).first()]))[0];
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/check-out',
    permission: 'coworking-checkins.checkins.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, params }) => {
      await db.transaction(async (trx) => {
        const v = await trx(VISITS).where({ uuid: params.uuid }).forUpdate().first();
        if (!v) throw notFound('Visit');
        if (v.checked_out_at) throw new AppError('CONFLICT', 'Already checked out');
        await trx(VISITS).where({ id: v.id }).update({ checked_out_at: new Date() });
        await audit(trx, ctx, {
          action: 'coworking-checkins.checked_out',
          entity: 'coworking-checkins.visit',
          entityId: v.id,
          entityUuid: params.uuid,
        });
      });
      return (await dtos([await db(VISITS).where({ uuid: params.uuid }).first()]))[0];
    },
  });

registerModuleWidget('coworking-checkins.today', async (_params, user) => {
  assertCan(user, 'coworking-checkins.checkins.view');
  const inNow = await db(VISITS).whereNull('checked_out_at').select('kind');
  const today = Number(
    (
      (await db(VISITS)
        .where('checked_in_at', '>=', await startOfToday())
        .count({ c: '*' })
        .first()) as { c: number }
    ).c,
  );
  return {
    members: inNow.filter((v) => v.kind === 'member').length,
    visitors: inNow.filter((v) => v.kind === 'visitor').length,
    today,
  };
});

export const coworkingCheckins: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_checkins': m0001 },
};
