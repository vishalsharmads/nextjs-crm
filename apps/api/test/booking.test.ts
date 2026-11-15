import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { computeSlots } from '@app/shared';
import { clientWithRoles, getApp, takeMail } from './helpers';
import { db } from '../src/db/knex';

describe('scheduling links', () => {
  it('computes free slots in the page’s time zone, around busy time and buffers, across a clock change', () => {
    // Monday 30 March 2026, after the UK moved to summer time (UTC+1).
    const now = new Date('2026-03-29T12:00:00Z');
    const slots = computeSlots({
      hours: { mon: [['09:00', '10:00']] },
      timeZone: 'Europe/London',
      type: { durationMin: 30, bufferMin: 0, noticeHours: 0, horizonDays: 2 },
      busy: [{ start: new Date('2026-03-30T08:10:00Z'), end: new Date('2026-03-30T08:20:00Z') }],
      now,
    });
    // 09:00 and 09:15 London (08:00, 08:15 UTC) overlap the busy time; 09:30 is free.
    expect(slots.map((d) => d.toISOString())).toEqual(['2026-03-30T08:30:00.000Z']);
    const withBuffer = computeSlots({
      hours: { mon: [['09:00', '10:00']] },
      timeZone: 'Europe/London',
      type: { durationMin: 30, bufferMin: 15, noticeHours: 0, horizonDays: 2 },
      busy: [{ start: new Date('2026-03-30T08:10:00Z'), end: new Date('2026-03-30T08:20:00Z') }],
      now,
    });
    expect(withBuffer).toEqual([]);
  });

  it('books a meeting through a public page, creates the visitor as a lead, and cancels with the emailed link', async () => {
    const { client, user } = await clientWithRoles(['admin']);
    const slug = `book-${Date.now().toString(36)}`;
    await client
      .put('/me/booking-page', {
        slug,
        title: 'Book a call',
        intro: 'Pick a time',
        timeZone: 'UTC',
        hours: {
          mon: [['00:00', '23:59']],
          tue: [['00:00', '23:59']],
          wed: [['00:00', '23:59']],
          thu: [['00:00', '23:59']],
          fri: [['00:00', '23:59']],
          sat: [['00:00', '23:59']],
          sun: [['00:00', '23:59']],
        },
        meetingTypes: [
          {
            key: 'intro',
            name: 'Intro call',
            durationMin: 30,
            noticeHours: 1,
            horizonDays: 7,
            questions: [{ key: 'topic', label: 'What about?', required: true }],
          },
        ],
      })
      .expect(200);
    const other = await clientWithRoles(['admin']);
    await other.client
      .put('/me/booking-page', {
        slug,
        title: 'x',
        timeZone: 'UTC',
        hours: {},
        meetingTypes: [{ key: 'a', name: 'A', durationMin: 30 }],
      })
      .expect(409);

    const app = await getApp();
    const page = await request(app).get(`/api/v1/public/book/${slug}`).expect(200);
    expect(page.body.meetingTypes[0].name).toBe('Intro call');
    expect(JSON.stringify(page.body)).not.toContain(user.email);
    const slots = await request(app).get(`/api/v1/public/book/${slug}/slots?type=intro`).expect(200);
    const start = slots.body.slots[2] as string;
    const email = `visitor-${Date.now()}@example.test`;

    await request(app)
      .post(`/api/v1/public/book/${slug}`)
      .send({ type: 'intro', start, name: 'Vera Visitor', email })
      .expect(422);
    takeMail();
    const booked = await request(app)
      .post(`/api/v1/public/book/${slug}`)
      .send({ type: 'intro', start, name: 'Vera Visitor', email, answers: { topic: 'Pricing' } })
      .expect(201);
    expect(booked.body.manageUrl).toContain('/book/manage/');
    // The visitor is a new lead with an invitation; the meeting is on the host's calendar.
    const lead = await db('leads').where({ email_norm: email }).first('id', 'owner_id', 'source');
    expect(lead).toMatchObject({ owner_id: user.id, source: 'Booking' });
    const meeting = await db('activities').where({ related_type: 'lead', related_id: lead.id }).first();
    expect(meeting).toMatchObject({ type: 'meeting', assignee_id: user.id });
    expect(meeting.body).toContain('Pricing');
    expect(takeMail().filter((m) => m.to === email && m.icalEvent?.method === 'REQUEST')).toHaveLength(1);

    // The slot is gone, and taking it again is refused.
    const after = await request(app).get(`/api/v1/public/book/${slug}/slots?type=intro`).expect(200);
    expect(after.body.slots).not.toContain(start);
    await request(app)
      .post(`/api/v1/public/book/${slug}`)
      .send({ type: 'intro', start, name: 'Someone', email: 'x@example.test', answers: { topic: 'x' } })
      .expect(409);

    // Bots filling the hidden field get a polite answer and no booking.
    await request(app)
      .post(`/api/v1/public/book/${slug}`)
      .send({
        type: 'intro',
        start: slots.body.slots[5],
        name: 'Bot',
        email: 'bot@example.test',
        answers: { topic: 'x' },
        website: 'spam',
      })
      .expect(201);
    expect(await db('leads').where({ email_norm: 'bot@example.test' }).first()).toBeUndefined();

    const token = new URL(booked.body.manageUrl).pathname.split('/').pop()!;
    const manage = await request(app).get(`/api/v1/public/book/manage/${token}`).expect(200);
    expect(manage.body).toMatchObject({ title: 'Book a call', type: 'Intro call', cancelled: false });
    takeMail();
    await request(app).post(`/api/v1/public/book/manage/${token}/cancel`).expect(204);
    expect((await db('activities').where({ id: meeting.id }).first()).deleted_at).not.toBeNull();
    expect(takeMail().filter((m) => m.to === email && m.icalEvent?.method === 'CANCEL')).toHaveLength(1);
    await request(app).post(`/api/v1/public/book/manage/${token}/cancel`).expect(404);

    // A page that is switched off is not found.
    await client
      .put('/me/booking-page', {
        slug,
        title: 'Book a call',
        timeZone: 'UTC',
        hours: {},
        meetingTypes: [{ key: 'intro', name: 'Intro call', durationMin: 30 }],
        active: false,
      })
      .expect(200);
    await request(app).get(`/api/v1/public/book/${slug}`).expect(404);
  });
});
