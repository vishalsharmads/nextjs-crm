import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, type Client } from './helpers';
import { checkOpeningHours } from '../../../modules/bookings/api';

const R = '/m/bookings/resources';
const B = '/m/bookings/bookings';
const at = (day: number, hhmm: string) => `2031-03-${String(day).padStart(2, '0')}T${hhmm}:00.000Z`;

describe('bookings', () => {
  let client: Client;
  let room: string;
  beforeAll(async () => {
    ({ client } = await clientWithRoles(['admin']));
    await client.post('/modules/bookings/enable').expect(200);
    const r = await client
      .post(R, {
        name: 'Board room',
        kind: 'room',
        capacity: 8,
        openTime: '08:00',
        closeTime: '18:00',
        openDays: [1, 2, 3, 4, 5],
      })
      .expect(201);
    room = r.body.uuid;
  });

  it('books free slots and refuses overlaps, but allows back-to-back bookings', async () => {
    // 2031-03-03 is a Monday; the test workspace runs in UTC.
    const first = await client
      .post(B, {
        resourceUuid: room,
        title: 'Planning',
        startsAt: at(3, '09:00'),
        endsAt: at(3, '10:00'),
        attendees: 4,
      })
      .expect(201);
    expect(first.body).toMatchObject({ status: 'confirmed', resource: { uuid: room } });
    const clash = await client.post(B, {
      resourceUuid: room,
      startsAt: at(3, '09:30'),
      endsAt: at(3, '11:00'),
    });
    expect(clash.status).toBe(409);
    await client
      .post(B, { resourceUuid: room, startsAt: at(3, '10:00'), endsAt: at(3, '11:00') })
      .expect(201);

    // Moving onto an occupied slot is refused; cancelling frees it.
    expect(
      (await client.patch(`${B}/${first.body.uuid}`, { startsAt: at(3, '10:30'), endsAt: at(3, '11:30') }))
        .status,
    ).toBe(409);
    await client.post(`${B}/${first.body.uuid}/cancel`, { reason: 'Moved online' }).expect(200);
    await client
      .post(B, { resourceUuid: room, startsAt: at(3, '09:00'), endsAt: at(3, '09:30') })
      .expect(201);

    const list = await client
      .get(`${B}?from=${at(3, '00:00')}&to=${at(4, '00:00')}&resourceUuid=${room}`)
      .expect(200);
    expect(list.body.data).toHaveLength(2);
  });

  it('enforces opening hours, open days, capacity and sensible ranges', async () => {
    const tooEarly = await client.post(B, {
      resourceUuid: room,
      startsAt: at(4, '07:00'),
      endsAt: at(4, '09:00'),
    });
    expect(tooEarly.status).toBe(422);
    const tooLate = await client.post(B, {
      resourceUuid: room,
      startsAt: at(4, '17:00'),
      endsAt: at(4, '19:00'),
    });
    expect(tooLate.status).toBe(422);
    // 2031-03-08 is a Saturday.
    expect(
      (await client.post(B, { resourceUuid: room, startsAt: at(8, '10:00'), endsAt: at(8, '11:00') })).status,
    ).toBe(422);
    expect(
      (
        await client.post(B, {
          resourceUuid: room,
          startsAt: at(4, '10:00'),
          endsAt: at(4, '11:00'),
          attendees: 9,
        })
      ).status,
    ).toBe(422);
    expect(
      (await client.post(B, { resourceUuid: room, startsAt: at(4, '11:00'), endsAt: at(4, '10:00') })).status,
    ).toBe(422);
    // Closing time is inclusive.
    await client
      .post(B, { resourceUuid: room, startsAt: at(4, '17:00'), endsAt: at(4, '18:00') })
      .expect(201);
  });

  it('checks opening hours in the workspace time zone', () => {
    const resource = { name: 'Desk', open_time: '09:00', close_time: '17:00', open_days: null };
    // 08:30 UTC is 09:30 in Paris (winter), so it is open there but not in UTC.
    const start = new Date('2031-01-06T08:30:00Z');
    const end = new Date('2031-01-06T09:30:00Z');
    expect(() => checkOpeningHours(resource, start, end, 'Europe/Paris')).not.toThrow();
    expect(() => checkOpeningHours(resource, start, end, 'UTC')).toThrow(/opens at 09:00/);
  });

  it('lets only one of two simultaneous requests take a slot', async () => {
    const body = { resourceUuid: room, startsAt: at(5, '13:00'), endsAt: at(5, '14:00') };
    const results = await Promise.all([client.post(B, body), client.post(B, body), client.post(B, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('reports occupancy and keeps inactive resources unbookable', async () => {
    const widget = await client.get('/dashboards/widgets/module:bookings.occupancy/data').expect(200);
    expect(widget.body.total).toBeGreaterThanOrEqual(1);
    const desk = await client.post(R, { name: 'Hot desk 1', kind: 'desk' }).expect(201);
    await client.patch(`${R}/${desk.body.uuid}`, { active: false }).expect(200);
    expect(
      (
        await client.post(B, {
          resourceUuid: desk.body.uuid,
          startsAt: at(6, '10:00'),
          endsAt: at(6, '11:00'),
        })
      ).status,
    ).toBe(409);
    const all = await client.get(`${R}?all=true`).expect(200);
    expect(all.body.data.find((r: { uuid: string }) => r.uuid === desk.body.uuid).active).toBe(false);
  });
});
