import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../db/knex';
import { defineRoutes } from '../../http/routes';
import { audit } from '../audit/audit.service';
import { getBranding } from '../settings/settings.service';
import { buildCalendar, uidFor, type IcsEvent } from './ics';
import { can, loadAccess } from '../rbac/access';
import type { AuthUser } from '../../http/context';

/**
 * A private iCalendar feed per person (meetings they hold or attend, tasks with a due time), for
 * calendar apps that subscribe to a web address. The address is a secret: anyone with it can read
 * the titles and times, so it can be replaced or removed at any time.
 */
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const feedUrl = (token: string) => `${new URL(env.APP_URL).origin}/api/v1/public/calendar/${token}.ics`;

export const calendarFeedRoutes = defineRoutes('/me/calendar-feed', ['me'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    handler: async ({ user }) => ({
      active: !!(await db('calendar_feeds').where({ user_id: user.id }).first('id')),
    }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'authenticated',
    summary: 'Create (or replace) the private calendar feed address; the old one stops working',
    handler: async ({ ctx, user }) => {
      const token = randomBytes(32).toString('base64url');
      await db.transaction(async (trx) => {
        await trx('calendar_feeds')
          .insert({ user_id: user.id, token_hash: hash(token), created_at: new Date() })
          .onConflict('user_id')
          .merge(['token_hash', 'created_at']);
        await audit(trx, ctx, { action: 'calendar_feed.created', entity: 'user', entityId: user.id });
      });
      return { url: feedUrl(token) };
    },
  })
  .add({
    method: 'delete',
    path: '/',
    permission: 'authenticated',
    status: 204,
    handler: async ({ ctx, user }) => {
      await db.transaction(async (trx) => {
        await trx('calendar_feeds').where({ user_id: user.id }).delete();
        await audit(trx, ctx, { action: 'calendar_feed.removed', entity: 'user', entityId: user.id });
      });
    },
  });

export const publicCalendarRoutes = defineRoutes('/public/calendar', ['public']).add({
  method: 'get',
  path: '/:file',
  permission: 'public',
  params: z.object({ file: z.string().regex(/^[A-Za-z0-9_-]{43}\.ics$/) }),
  summary: 'A person’s private calendar feed',
  handler: async ({ params, res }) => {
    const feed = await db('calendar_feeds')
      .where({ token_hash: hash(params.file.slice(0, -4)) })
      .first('user_id');
    const user = feed
      ? await db('users').where({ id: feed.user_id, status: 'active' }).whereNull('deleted_at').first('id')
      : null;
    // The person must still be allowed to see activities (a role change ends the feed's content too).
    const access = user ? await loadAccess(user.id as number) : null;
    if (!user || !access || !can({ id: user.id, ...access } as unknown as AuthUser, 'core.activities.view')) {
      res.status(404).type('text/plain').send('This calendar address is no longer valid.');
      return;
    }
    const from = new Date(Date.now() - 60 * 86_400_000);
    const to = new Date(Date.now() + 365 * 86_400_000);
    const rows = await db('activities')
      .whereNull('deleted_at')
      .where((w) =>
        w
          .where((m) => m.where('type', 'meeting').whereBetween('start_at', [from, to]))
          .orWhere((k) =>
            k.whereIn('type', ['task', 'call']).whereNull('completed_at').whereBetween('due_at', [from, to]),
          ),
      )
      .where((w) =>
        w
          .where('assignee_id', user.id)
          .orWhereExists((e) =>
            e
              .select(db.raw('1'))
              .from('activity_participants as ap')
              .whereRaw('ap.activity_id = activities.id')
              .where({ 'ap.kind': 'user', 'ap.record_id': user.id }),
          ),
      )
      // Nothing about people whose processing is restricted.
      .whereNotExists((e) =>
        e
          .select(db.raw('1'))
          .from('contacts as c')
          .whereRaw("activities.related_type = 'contact' AND c.id = activities.related_id")
          .where('c.processing_restricted', true),
      )
      .whereNotExists((e) =>
        e
          .select(db.raw('1'))
          .from('leads as l')
          .whereRaw("activities.related_type = 'lead' AND l.id = activities.related_id")
          .where('l.processing_restricted', true),
      )
      .orderByRaw('COALESCE(start_at, due_at)')
      .limit(2000)
      .select(
        'uuid',
        'type',
        'subject',
        'start_at',
        'end_at',
        'due_at',
        'ical_sequence',
        'updated_at',
        'outcome',
      );
    const app = new URL(env.APP_URL);
    const events: IcsEvent[] = rows.map((r) => ({
      uid: uidFor(r.uuid as string),
      sequence: r.ical_sequence as number,
      start: (r.start_at ?? r.due_at) as Date,
      end: (r.type === 'meeting' ? r.end_at : null) as Date | null,
      summary: (r.subject as string) || (r.type === 'meeting' ? 'Meeting' : 'Task'),
      // Titles and times only: notes stay in the app, behind sign-in.
      description: null,
      url: `${app.origin}${app.pathname.replace(/\/$/, '')}/tasks/${r.uuid as string}`,
      status: r.outcome === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
      updated: r.updated_at as Date,
    }));
    const { appName } = await getBranding();
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' });
    res.send(buildCalendar(events, { name: appName }));
  },
});
