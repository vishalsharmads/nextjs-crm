import { db, type Db } from '../../db/knex';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { newUuid } from '../../lib/ids';
import { sendTemplatedEmail } from '../mail/templates';
import { effectiveCompliance } from '../settings/settings.service';

export interface NotifyInput {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  data?: Record<string, unknown>;
  /** Also send an email (respects the user's preference). */
  email?: boolean;
}

interface Prefs {
  emailNotifications?: boolean;
}

/** In-app notification, optionally mirrored by email. Never notifies the actor about their own action. */
export async function notify(
  userId: number,
  input: NotifyInput,
  opts: { actorId?: number | null; conn?: Db } = {},
) {
  if (opts.actorId && opts.actorId === userId) return;
  const conn = opts.conn ?? db;
  const user = await conn('users')
    .where({ id: userId, status: 'active' })
    .whereNull('deleted_at')
    .first('id', 'email', 'first_name', 'preferences');
  if (!user) return;
  const uuid = newUuid();
  await conn('notifications').insert({
    uuid,
    user_id: userId,
    type: input.type,
    title: input.title.slice(0, 255),
    body: input.body ?? null,
    link: input.link ?? null,
    data: input.data ? JSON.stringify(input.data) : null,
  });
  const prefs = (user.preferences ?? {}) as Prefs;
  if (input.email && prefs.emailNotifications !== false) {
    // Email after commit, best-effort: a mail outage must not roll back the business change.
    // Minimal mode (forced by the health data profile): email leaves the system, so it carries no
    // names or details; the in-app notification, behind sign-in, keeps them.
    const minimal = (await effectiveCompliance()).notificationEmailMinimal;
    setImmediate(() => {
      sendTemplatedEmail('notification.generic', user.email, {
        title: minimal ? 'You have a new notification' : input.title,
        body: minimal ? 'Sign in to see the details.' : (input.body ?? ''),
        link: input.link ? `${env.APP_URL}${input.link}` : '',
      })
        .then(() => db('notifications').where({ uuid }).update({ emailed_at: new Date() }))
        .catch((err: unknown) => logger.warn({ err }, 'Notification email failed'));
    });
  }
}

/** Send due activity reminders (runs every minute). */
export async function sendDueReminders(now = new Date()): Promise<number> {
  const due = await db('activities')
    .whereNull('deleted_at')
    .whereNull('completed_at')
    .whereNotNull('reminder_at')
    .whereNull('reminded_at')
    .where('reminder_at', '<=', now)
    .limit(200);
  for (const a of due) {
    // Claim the row first so concurrent workers never double-send.
    const claimed = await db('activities')
      .where({ id: a.id })
      .whereNull('reminded_at')
      .update({ reminded_at: now });
    if (!claimed || !a.assignee_id) continue;
    await notify(a.assignee_id, {
      type: 'activity.reminder',
      title: `Reminder: ${a.subject || a.type}`,
      body: a.due_at ? `Due ${new Date(a.due_at).toUTCString()}` : null,
      link: await activityLink(a.related_type, a.related_id),
      email: true,
    });
  }
  return due.length;
}

const ROUTE: Record<string, { table: string; route: string }> = {
  contact: { table: 'contacts', route: 'contacts' },
  organization: { table: 'organizations', route: 'organizations' },
  deal: { table: 'deals', route: 'deals' },
  lead: { table: 'leads', route: 'leads' },
};

async function activityLink(type: string | null, id: number | null): Promise<string> {
  const meta = type ? ROUTE[type] : undefined;
  if (!meta || !id) return '/tasks';
  const row = await db(meta.table).where({ id }).first('uuid');
  return row ? `/${meta.route}/${row.uuid}` : '/tasks';
}
