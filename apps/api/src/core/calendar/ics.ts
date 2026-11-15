import { env } from '../../config/env';

/** iCalendar (RFC 5545) text: escaping, line folding, UTC times. */
const escape = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 octets continue on the next line after a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (parts.length ? 74 : 75), bytes.length);
    // Never cut a multi-byte character in half.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

export const icsTime = (d: Date | string) =>
  new Date(d)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export const uidFor = (activityUuid: string) => `${activityUuid}@${new URL(env.APP_URL).hostname}`;

export interface IcsEvent {
  uid: string;
  sequence?: number;
  start: Date | string;
  end?: Date | string | null;
  summary: string;
  description?: string | null;
  url?: string | null;
  status?: 'CONFIRMED' | 'CANCELLED';
  organizer?: { name: string; email: string } | null;
  attendees?: { name: string; email: string; status?: string | null }[];
  updated?: Date | string;
}

function eventLines(e: IcsEvent): string[] {
  const end = e.end ?? new Date(new Date(e.start).getTime() + 30 * 60_000);
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsTime(e.updated ?? new Date())}`,
    `SEQUENCE:${e.sequence ?? 0}`,
    `DTSTART:${icsTime(e.start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${escape(e.summary || 'Meeting')}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${escape(e.description)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  if (e.status) lines.push(`STATUS:${e.status}`);
  if (e.organizer) lines.push(`ORGANIZER;CN=${escape(e.organizer.name)}:mailto:${e.organizer.email}`);
  for (const a of e.attendees ?? [])
    lines.push(
      `ATTENDEE;CN=${escape(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=${(a.status ?? 'NEEDS-ACTION').toUpperCase().replace('_', '-')};RSVP=TRUE:mailto:${a.email}`,
    );
  lines.push('END:VEVENT');
  return lines;
}

/** A calendar with events; `method` for invitations (REQUEST, CANCEL), none for feeds and CalDAV. */
export function buildCalendar(
  events: IcsEvent[],
  opts: { method?: 'REQUEST' | 'CANCEL'; name?: string } = {},
): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//crm//calendar//EN', 'CALSCALE:GREGORIAN'];
  if (opts.method) lines.push(`METHOD:${opts.method}`);
  if (opts.name) lines.push(`X-WR-CALNAME:${escape(opts.name)}`);
  for (const e of events) lines.push(...eventLines(e));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** HTML of a rich-text body as plain text for DESCRIPTION. */
export const plain = (html: string | null | undefined) =>
  (html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
