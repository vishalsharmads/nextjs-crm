import ICAL from 'ical.js';
import type { ParsedMail } from 'mailparser';
import { env } from '../../config/env';
import { db, type Db } from '../../db/knex';
import { enqueue, registerJob } from '../../lib/jobs';
import { logger } from '../../lib/logger';
import { sendMail } from '../../lib/mailer';
import { onEvent } from '../events/events';
import { getBranding } from '../settings/settings.service';
import { buildCalendar, plain, uidFor } from './ics';

/**
 * Meeting invitations by email with an .ics part (METHOD:REQUEST), updates when the time or title
 * changes (a higher SEQUENCE), cancellations when the meeting is deleted, and attendee replies
 * (METHOD:REPLY) read by mailbox sync. Restricted people are never sent invitations.
 */
interface Attendee {
  participantId: number;
  name: string;
  email: string;
  status: string | null;
}

async function attendeesOf(conn: Db, activityId: number): Promise<Attendee[]> {
  const rows = await conn('activity_participants')
    .where({ activity_id: activityId })
    .whereIn('kind', ['contact', 'lead', 'user']);
  const out: Attendee[] = [];
  for (const r of rows) {
    const table = r.kind === 'user' ? 'users' : r.kind === 'contact' ? 'contacts' : 'leads';
    const p = await conn(table).where({ id: r.record_id }).first();
    if (!p?.email) continue;
    if (r.kind !== 'user' && p.processing_restricted) continue;
    const name =
      r.kind === 'user' ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() : (p.full_name as string) || '';
    out.push({
      participantId: r.id,
      name: name || p.email,
      email: String(p.email).toLowerCase(),
      status: r.status,
    });
  }
  return out;
}

/** The organizer: the person the meeting is assigned to, with their connected mailbox address if any. */
async function organizerOf(conn: Db, a: { assignee_id: number | null; owner_id: number | null }) {
  const id = a.assignee_id ?? a.owner_id;
  const u = id ? await conn('users').where({ id }).first('id', 'email', 'first_name', 'last_name') : null;
  if (!u) return null;
  const mailbox = await conn('mail_accounts').where({ user_id: u.id, active: true }).first('email');
  return {
    name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email,
    email: (mailbox?.email ?? u.email) as string,
  };
}

export async function queueInvitations(activityId: number, method: 'REQUEST' | 'CANCEL') {
  await enqueue('calendar.invite', { activityId, method });
}

registerJob('calendar.invite', async (job) => {
  const activityId = job.payload.activityId as number;
  const method = job.payload.method as 'REQUEST' | 'CANCEL';
  const a = await db('activities').where({ id: activityId }).first();
  if (!a || a.type !== 'meeting' || !a.start_at) return;
  const attendees = await attendeesOf(db, activityId);
  const organizer = await organizerOf(db, a);
  if (!organizer || !attendees.length) return;
  const invited = attendees.filter((x) => x.email !== organizer.email.toLowerCase());
  const content = buildCalendar(
    [
      {
        uid: uidFor(a.uuid),
        sequence: a.ical_sequence,
        start: a.start_at,
        end: a.end_at,
        summary: a.subject,
        description: plain(a.body).slice(0, 2000) || null,
        status: method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED',
        organizer,
        attendees: invited.map((x) => ({ name: x.name, email: x.email, status: x.status })),
        updated: a.updated_at,
      },
    ],
    { method },
  );
  const { appName } = await getBranding();
  const when = new Date(a.start_at).toUTCString();
  for (const x of invited) {
    try {
      await sendMail({
        to: x.email,
        subject: `${method === 'CANCEL' ? 'Cancelled' : 'Invitation'}: ${a.subject}`,
        text: `${method === 'CANCEL' ? 'Cancelled' : 'Invitation'}: ${a.subject}\n${when}\n\n${organizer.name}`,
        html: `<p><strong>${method === 'CANCEL' ? 'Cancelled' : 'Invitation'}: ${escapeHtml(a.subject)}</strong></p><p>${when}</p><p>${escapeHtml(organizer.name)}</p>`,
        fromName: organizer.name || appName,
        replyTo: organizer.email,
        icalEvent: { method, content },
      });
    } catch (err) {
      logger.warn({ err }, 'Invitation could not be sent');
    }
  }
  if (method === 'REQUEST')
    await db('activity_participants')
      .whereIn(
        'id',
        invited.map((x) => x.participantId),
      )
      .update({ invited_at: new Date(), status: db.raw("COALESCE(status, 'needs_action')") });
});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** After a meeting is saved: invite on request, and send updates to people already invited. */
export async function afterMeetingWrite(
  conn: Db,
  id: number,
  op: 'create' | 'update',
  invite: boolean,
  existing?: Record<string, unknown>,
) {
  const now = await conn('activities').where({ id }).first('type', 'start_at', 'end_at', 'subject');
  if (now?.type !== 'meeting' || !now.start_at) return;
  const invitedBefore = await conn('activity_participants')
    .where({ activity_id: id })
    .whereNotNull('invited_at')
    .first('id');
  const changed =
    op === 'update' &&
    !!existing &&
    (String(existing.start_at) !== String(now.start_at) ||
      String(existing.end_at) !== String(now.end_at) ||
      existing.subject !== now.subject);
  if (!invite && !(invitedBefore && changed)) return;
  // Sent after the save commits (the activity.created/updated event), so the job sees the participants.
  await conn('activities')
    .where({ id })
    .update({
      invite_pending: true,
      ...(op === 'update' ? { ical_sequence: conn.raw('ical_sequence + 1') } : {}),
    });
}

onEvent(async (e) => {
  if (e.type !== 'activity.created' && e.type !== 'activity.updated') return;
  const a = await db('activities').where({ uuid: e.uuid, invite_pending: true }).first('id');
  if (!a) return;
  await db('activities').where({ id: a.id }).update({ invite_pending: false });
  await queueInvitations(a.id as number, 'REQUEST');
});

// A deleted meeting that people were invited to is cancelled for them.
onEvent(async (e) => {
  if (e.type !== 'activity.deleted') return;
  const a = await db('activities').where({ uuid: e.uuid }).first('id', 'type');
  if (a?.type !== 'meeting') return;
  if (
    !(await db('activity_participants').where({ activity_id: a.id }).whereNotNull('invited_at').first('id'))
  )
    return;
  await db('activities').where({ id: a.id }).increment('ical_sequence', 1);
  await queueInvitations(a.id as number, 'CANCEL');
});

const STATUS: Record<string, string> = {
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
  'NEEDS-ACTION': 'needs_action',
};

/**
 * An attendee's answer (METHOD:REPLY) found in synced mail: set their status on the meeting.
 * Returns true when the message was a reply to one of our invitations.
 */
export async function applyInvitationReply(parsed: ParsedMail): Promise<boolean> {
  const part = parsed.attachments?.find((x) => /text\/calendar/i.test(x.contentType));
  if (!part) return false;
  try {
    const cal = new ICAL.Component(ICAL.parse(part.content.toString('utf8')));
    if (String(cal.getFirstPropertyValue('method') ?? '').toUpperCase() !== 'REPLY') return false;
    const ev = cal.getFirstSubcomponent('vevent');
    const uid = String(ev?.getFirstPropertyValue('uid') ?? '');
    const host = new URL(env.APP_URL).hostname;
    if (!uid.endsWith(`@${host}`)) return false;
    const activity = await db('activities')
      .where({ uuid: uid.slice(0, -host.length - 1) })
      .first('id');
    if (!activity) return false;
    for (const prop of ev?.getAllProperties('attendee') ?? []) {
      const email = String(prop.getFirstValue() ?? '')
        .replace(/^mailto:/i, '')
        .toLowerCase();
      const status = STATUS[String(prop.getParameter('partstat') ?? '').toUpperCase()];
      if (!email || !status) continue;
      for (const [kind, table, col] of [
        ['contact', 'contacts', 'email_norm'],
        ['lead', 'leads', 'email_norm'],
        ['user', 'users', 'email'],
      ] as const) {
        const ids = (await db(table).where(col, email).pluck('id')) as number[];
        if (ids.length)
          await db('activity_participants')
            .where({ activity_id: activity.id, kind })
            .whereIn('record_id', ids)
            .update({ status });
      }
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'Calendar reply could not be read');
    return false;
  }
}
