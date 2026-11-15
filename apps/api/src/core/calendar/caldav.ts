import { env } from '../../config/env';
import { decrypt } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { safeRequest } from '../../lib/safe-net';

/**
 * A minimal CalDAV client (RFC 4791): check a calendar collection, read events in a time range,
 * write and delete one event. Every request goes through `safeRequest` (address pinned, no
 * redirects), because the calendar address comes from the person.
 */
export interface CalendarAccount {
  id: number;
  user_id: number;
  url: string;
  username: string;
  password_enc: string;
}

const auth = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const collection = (url: string) => (url.endsWith('/') ? url : `${url}/`);

async function dav(
  account: Pick<CalendarAccount, 'username' | 'password_enc'> & { password?: string },
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {},
) {
  const password = account.password ?? decrypt(account.password_enc, 'calendar_accounts.password_enc');
  return safeRequest(
    method,
    url,
    {
      Authorization: auth(account.username, password),
      ...(body ? { 'Content-Type': headers['Content-Type'] ?? 'application/xml; charset=utf-8' } : {}),
      ...headers,
    },
    body,
    { allowPrivate: env.WEBHOOKS_ALLOW_PRIVATE },
  );
}

/** Check that the address is a calendar the person can read. */
export async function verifyCalendar(url: string, username: string, password: string) {
  const res = await dav(
    { username, password_enc: '', password },
    'PROPFIND',
    collection(url),
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>',
    { Depth: '0' },
  );
  if (res.status === 401 || res.status === 403)
    throw new AppError(
      'VALIDATION_FAILED',
      'The calendar server refused the sign-in. Check the user name and password.',
    );
  if (res.status !== 207 || !/<[^>]*calendar[\s/>]/i.test(res.body))
    throw new AppError(
      'VALIDATION_FAILED',
      'That address is not a calendar. Use the address of one calendar (a CalDAV collection).',
    );
  const name = /<(?:\w+:)?displayname>([^<]*)</i.exec(res.body)?.[1] ?? '';
  return { displayName: decodeXml(name).trim() };
}

const decodeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;/g, '\r')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');

export interface RemoteEvent {
  href: string;
  etag: string | null;
  ics: string;
}

const ical = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** Events overlapping a time range, with their address and version tag. */
export async function fetchEvents(account: CalendarAccount, from: Date, to: Date): Promise<RemoteEvent[]> {
  const res = await dav(
    account,
    'REPORT',
    collection(account.url),
    `<?xml version="1.0"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${ical(from)}" end="${ical(to)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`,
    { Depth: '1' },
  );
  if (res.status !== 207) throw new AppError('UPSTREAM_FAILED', `The calendar server answered ${res.status}`);
  const out: RemoteEvent[] = [];
  for (const m of res.body.matchAll(/<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/gi)) {
    const block = m[0];
    const href = /<(?:\w+:)?href>([^<]+)</i.exec(block)?.[1];
    const data = /<(?:\w+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:\w+:)?calendar-data>/i.exec(block)?.[1];
    if (!href || !data) continue;
    const etag = /<(?:\w+:)?getetag>([^<]*)</i.exec(block)?.[1] ?? null;
    // Only addresses on the calendar's own server: a server may not point us (and the password) elsewhere.
    const target = new URL(decodeXml(href.trim()), account.url);
    if (target.origin !== new URL(account.url).origin) continue;
    out.push({
      href: target.toString(),
      etag: etag ? decodeXml(etag) : null,
      ics: decodeXml(data),
    });
  }
  return out;
}

/** Create or replace one event. Returns its address and new version tag. */
export async function putEvent(
  account: CalendarAccount,
  uid: string,
  ics: string,
  existing?: { href: string; etag: string | null },
): Promise<{ href: string; etag: string | null }> {
  const href = existing?.href ?? `${collection(account.url)}${encodeURIComponent(uid)}.ics`;
  const res = await dav(account, 'PUT', href, ics, {
    'Content-Type': 'text/calendar; charset=utf-8',
    ...(existing?.etag ? { 'If-Match': existing.etag } : existing ? {} : { 'If-None-Match': '*' }),
  });
  if (res.status === 412) throw new AppError('CONFLICT', 'The event changed in the calendar meanwhile');
  if (res.status < 200 || res.status >= 300)
    throw new AppError('UPSTREAM_FAILED', `The calendar server answered ${res.status}`);
  const etag = res.headers.etag;
  return { href, etag: typeof etag === 'string' ? etag : null };
}

export async function deleteEvent(account: CalendarAccount, href: string) {
  const res = await dav(account, 'DELETE', href);
  if (res.status >= 300 && res.status !== 404)
    throw new AppError('UPSTREAM_FAILED', `The calendar server answered ${res.status}`);
}
