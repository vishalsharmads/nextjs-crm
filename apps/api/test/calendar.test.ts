import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { simpleParser } from 'mailparser';
import { clientWithRoles, createUser, getApp, takeMail } from './helpers';
import { db } from '../src/db/knex';
import { applyInvitationReply } from '../src/core/calendar/invites';
import { syncCalendar } from '../src/core/calendar/sync';
import { uidFor } from '../src/core/calendar/ics';

// ---------- A tiny CalDAV server ----------
const store = new Map<string, { ics: string; etag: string }>();
let version = 0;
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers.authorization !== `Basic ${Buffer.from('cal:secret').toString('base64')}`) {
        res.statusCode = 401;
        return res.end();
      }
      const path = req.url!;
      if (req.method === 'PROPFIND') {
        res.statusCode = 207;
        return res.end(
          '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname></d:prop></d:propstat></d:response></d:multistatus>',
        );
      }
      if (req.method === 'REPORT') {
        res.statusCode = 207;
        const items = [...store.entries()]
          .map(
            ([href, e]) =>
              `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${e.etag}</d:getetag><c:calendar-data>${e.ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data></d:prop></d:propstat></d:response>`,
          )
          .join('');
        return res.end(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${items}</d:multistatus>`,
        );
      }
      if (req.method === 'PUT') {
        const etag = `"v${++version}"`;
        store.set(path, { ics: body, etag });
        res.statusCode = 201;
        res.setHeader('ETag', etag);
        return res.end();
      }
      if (req.method === 'DELETE') {
        store.delete(path);
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 405;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/cal/`;
});
afterAll(() => server.close());

const iso = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const remoteEvent = (uid: string, start: Date, attendees: string[], extra: string[] = []) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${iso(new Date())}`,
    `DTSTART:${iso(start)}`,
    `DTEND:${iso(new Date(start.getTime() + 3600_000))}`,
    'SUMMARY:Quarterly review',
    ...attendees.map((a) => `ATTENDEE:mailto:${a}`),
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

describe('calendar', () => {
  it('serves a private feed of the person’s meetings, replaced and removed on request', async () => {
    const { client, user } = await clientWithRoles(['admin']);
    await client
      .post('/activities', {
        type: 'meeting',
        subject: 'Feed; meeting, with commas',
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
        assigneeUuid: user.uuid,
      })
      .expect(201);
    const first = await client.post('/me/calendar-feed').expect(200);
    const app = await getApp();
    const path = new URL(first.body.url).pathname;
    const feed = await request(app)
      .get(path)
      .expect(200)
      .expect('Content-Type', /text\/calendar/);
    expect(feed.text).toContain(String.raw`SUMMARY:Feed\; meeting\, with commas`);
    const second = await client.post('/me/calendar-feed').expect(200);
    await request(app).get(path).expect(404);
    await client.delete('/me/calendar-feed').expect(204);
    await request(app).get(new URL(second.body.url).pathname).expect(404);
  });

  it('invites participants, sends updates and a cancellation, and reads their replies', async () => {
    const { client } = await clientWithRoles(['admin']);
    const stamp = Date.now();
    const contact = await client
      .post('/contacts', { firstName: 'Guest', email: `guest-${stamp}@example.test` })
      .expect(201);
    takeMail();
    const meeting = await client
      .post('/activities', {
        type: 'meeting',
        subject: `Demo ${stamp}`,
        startAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        participants: [{ kind: 'contact', uuid: contact.body.uuid }],
        invite: true,
      })
      .expect(201);
    const mine = () => takeMail().filter((m) => m.to === `guest-${stamp}@example.test`);
    const invite = mine();
    expect(invite).toHaveLength(1);
    expect(invite[0]!.icalEvent?.method).toBe('REQUEST');
    expect(invite[0]!.icalEvent?.content).toContain(`UID:${meeting.body.uuid}@`);
    expect(invite[0]!.icalEvent?.content).toContain('SEQUENCE:0');

    // Changing the time sends an update; changing only the notes does not.
    await client.patch(`/activities/${meeting.body.uuid}`, { body: '<p>Agenda</p>' }).expect(200);
    expect(mine()).toHaveLength(0);
    await client
      .patch(`/activities/${meeting.body.uuid}`, {
        startAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      })
      .expect(200);
    const update = mine();
    expect(update).toHaveLength(1);
    expect(update[0]!.icalEvent?.content).toContain('SEQUENCE:1');

    // The guest accepts.
    const reply = await simpleParser(
      [
        `From: guest-${stamp}@example.test`,
        'To: me@example.test',
        'Subject: Accepted',
        'MIME-Version: 1.0',
        'Content-Type: text/calendar; method=REPLY; charset=utf-8',
        '',
        'BEGIN:VCALENDAR',
        'METHOD:REPLY',
        'BEGIN:VEVENT',
        `UID:${uidFor(meeting.body.uuid)}`,
        `ATTENDEE;PARTSTAT=ACCEPTED:mailto:guest-${stamp}@example.test`,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    expect(await applyInvitationReply(reply)).toBe(true);
    const part = await db('activity_participants')
      .join('activities as a', 'a.id', 'activity_participants.activity_id')
      .where('a.uuid', meeting.body.uuid)
      .first('activity_participants.status');
    expect(part.status).toBe('accepted');

    await client.delete(`/activities/${meeting.body.uuid}`).expect(204);
    const cancel = mine();
    expect(cancel).toHaveLength(1);
    expect(cancel[0]!.icalEvent?.method).toBe('CANCEL');
  });

  it('syncs a CalDAV calendar both ways', async () => {
    const owner = await createUser({ roleKeys: ['admin'] });
    const { client } = await clientWithRoles(['admin']);
    const stamp = Date.now();
    await client.post('/contacts', { firstName: 'Cal', email: `cal-${stamp}@example.test` }).expect(201);
    await db('calendar_accounts').where({ user_id: owner.id }).delete();
    // Connecting checks the address is a calendar.
    const { client: ownerClient } = await (async () => {
      const { loginAs } = await import('./helpers');
      return { client: await loginAs(owner) };
    })();
    await ownerClient
      .post('/calendar/accounts', { url: base, username: 'cal', password: 'wrong' })
      .expect(422);
    const acc = await ownerClient
      .post('/calendar/accounts', { url: base, username: 'cal', password: 'secret' })
      .expect(201);
    expect(acc.body.displayName).toBe('Work');

    const start = new Date(Date.now() + 5 * 86_400_000);
    store.set(`/cal/a-${stamp}.ics`, {
      ics: remoteEvent(`a-${stamp}`, start, [`cal-${stamp}@example.test`, owner.email]),
      etag: '"x1"',
    });
    store.set(`/cal/r-${stamp}.ics`, {
      ics: remoteEvent(`r-${stamp}`, start, ['someone@else.test'], ['RRULE:FREQ=WEEKLY;COUNT=3']),
      etag: '"x2"',
    });
    const res = await ownerClient.post(`/calendar/accounts/${acc.body.uuid}/sync`).expect(200);
    expect(res.body.logged).toBe(1);
    const link = await db('calendar_links')
      .where({ uid: `a-${stamp}` })
      .first();
    const meeting = await db('activities').where({ id: link.activity_id }).first();
    expect(meeting.subject).toBe('Quarterly review');
    const account = await db('calendar_accounts').where({ uuid: acc.body.uuid }).first();
    // One single event plus three occurrences of the weekly one are busy time.
    expect(
      await db('calendar_busy').where({ account_id: account.id }).count({ c: '*' }).first(),
    ).toMatchObject({ c: 4 });

    // A change in the calendar (newer than the CRM's) updates the meeting.
    const moved = new Date(start.getTime() + 7200_000);
    store.set(`/cal/a-${stamp}.ics`, {
      ics: remoteEvent(
        `a-${stamp}`,
        moved,
        [`cal-${stamp}@example.test`],
        [`LAST-MODIFIED:${iso(new Date(Date.now() + 60_000))}`],
      ),
      etag: '"x3"',
    });
    await syncCalendar(account);
    expect(
      new Date((await db('activities').where({ id: link.activity_id }).first()).start_at).getTime(),
    ).toBe(Math.floor(moved.getTime() / 1000) * 1000);

    // A meeting made in the CRM goes to the calendar.
    const crm = await ownerClient
      .post('/activities', { type: 'meeting', subject: `From CRM ${stamp}`, startAt: start.toISOString() })
      .expect(201);
    const pushed = [...store.values()].find((e) => e.ics.includes(`From CRM ${stamp}`));
    expect(pushed?.ics).toContain(`UID:${crm.body.uuid}@`);
  });
});
