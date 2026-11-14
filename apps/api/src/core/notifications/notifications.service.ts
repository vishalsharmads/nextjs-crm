import { db, type Db } from '../../db/knex';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { newUuid } from '../../lib/ids';
import { sendTemplatedEmail } from '../mail/templates';
import { hasPermission, wallClock, zonedTime } from '@app/shared';
import { loadAccess } from '../rbac/access';
import { effectiveCompliance, getGroup } from '../settings/settings.service';
import { DEFAULT_NOTIFICATION_PUSH, notificationCategory, type NotificationCategory } from '@app/shared';
import { queuePush } from '../push/push';

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
  notificationCategories?: Partial<Record<NotificationCategory, { email?: boolean; push?: boolean }>>;
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
  const category = notificationCategory(input.type);
  const chosen = prefs.notificationCategories?.[category];
  // Email: off everywhere when the person turned email off; otherwise their choice for this kind,
  // or what the sender asked for. In-app notifications are always kept.
  const wantEmail = prefs.emailNotifications !== false && (chosen?.email ?? !!input.email);
  if (chosen?.push ?? DEFAULT_NOTIFICATION_PUSH[category]) {
    const minimal = (await effectiveCompliance()).notificationEmailMinimal;
    // Push text shows on a lock screen: under the health data profile it carries no details.
    await queuePush(userId, {
      title: minimal ? 'You have a new notification' : input.title,
      body: minimal ? undefined : (input.body ?? undefined),
      link: input.link ?? undefined,
      tag: uuid,
    }).catch((err: unknown) => logger.warn({ err }, 'Push could not be queued'));
  }
  if (wantEmail) {
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
      link: `/tasks/${a.uuid as string}`,
      email: true,
    });
  }
  return due.length;
}

const DIGEST_HOUR = 8;

/**
 * Each morning (08:00 workspace time or later), email people who turned the digest on a list of
 * their open tasks due today and overdue. Runs often; each person is claimed once per local date
 * with a conditional update, so concurrent workers and restarts never send twice. Skipped in the
 * minimal-email compliance mode, because the list names tasks and records.
 */
export async function sendTaskDigests(now = new Date()): Promise<number> {
  if ((await effectiveCompliance()).notificationEmailMinimal) return 0;
  const { timezone } = await getGroup('general');
  const tz = timezone || 'UTC';
  const local = wallClock(now, tz);
  if (local.hh < DIGEST_HOUR) return 0;
  const today = `${local.y}-${String(local.m).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`;
  const endOfDay = zonedTime({ ...local, hh: 23, mm: 59 }, tz);
  const users = await db('users')
    .where({ status: 'active' })
    .whereNull('deleted_at')
    .whereRaw("JSON_EXTRACT(preferences, '$.taskDigest') = CAST('true' AS JSON)")
    .select('id', 'email', 'first_name');
  let sent = 0;
  for (const u of users) {
    const claimed = await db('users')
      .where({ id: u.id })
      .whereRaw("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(preferences, '$.taskDigestSent')), '') <> ?", [today])
      .update({
        preferences: db.raw("JSON_SET(COALESCE(preferences, JSON_OBJECT()), '$.taskDigestSent', ?)", [today]),
      });
    if (!claimed) continue;
    // Only people who may still see tasks get their subjects by email.
    const access = await loadAccess(u.id as number);
    if (!access.isAdmin && !hasPermission(access.permissions, 'core.activities.view')) continue;
    const rows = await db('activities')
      .where({ assignee_id: u.id })
      .whereNull('deleted_at')
      .whereNull('completed_at')
      .whereNot('type', 'note')
      .whereNotNull('due_at')
      .where('due_at', '<=', endOfDay)
      .orderBy('due_at')
      .limit(50)
      .select('uuid', 'subject', 'type', 'due_at');
    if (!rows.length) continue;
    const startOfDay = zonedTime({ ...local, hh: 0, mm: 0 }, tz);
    const item = (r: (typeof rows)[number]) => ({
      subject: r.subject || r.type,
      link: `${env.APP_URL}/tasks/${r.uuid}`,
      time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(
        new Date(r.due_at),
      ),
    });
    const overdue = rows.filter((r) => new Date(r.due_at) < startOfDay).map(item);
    const dueToday = rows.filter((r) => new Date(r.due_at) >= startOfDay).map(item);
    try {
      await sendTemplatedEmail('tasks.digest', u.email, {
        user: { firstName: u.first_name },
        count: rows.length,
        overdue,
        today: dueToday,
        tasksLink: `${env.APP_URL}/tasks`,
      });
      sent++;
    } catch (err) {
      logger.warn({ err }, 'Task digest email failed');
    }
  }
  return sent;
}
