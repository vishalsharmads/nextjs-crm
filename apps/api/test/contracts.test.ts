import { beforeAll, describe, expect, it } from 'vitest';
import { addMonths } from '../src/core/commerce/documents';
import { clientWithRoles, createRole } from './helpers';
import { db } from '../src/db/knex';
import { runRenewals } from '../../../modules/contracts/api';

const BASE = '/m/contracts/contracts';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

describe('contracts and renewals', () => {
  beforeAll(async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.post('/modules/contracts/enable').expect(200);
  });

  it('adds calendar months without overflowing short months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('activates, locks dates while active, renews into the next term, and cancels', async () => {
    const { client } = await clientWithRoles(['admin']);
    expect(
      (await client.post(BASE, { title: 'Bad dates', startDate: '2026-02-01', endDate: '2026-01-01' }))
        .status,
    ).toBe(422);
    const c = await client
      .post(BASE, { title: 'Office lease', value: 12000, billingCycle: 'monthly', renewalTermMonths: 12 })
      .expect(201);
    expect(c.body).toMatchObject({ status: 'draft', number: expect.stringMatching(/^C-\d{4}$/) });
    expect((await client.post(`${BASE}/${c.body.uuid}/activate`)).status).toBe(422);
    await client
      .patch(`${BASE}/${c.body.uuid}`, { startDate: '2026-01-01', endDate: '2026-12-31' })
      .expect(200);
    await client.post(`${BASE}/${c.body.uuid}/activate`).expect(200);

    expect((await client.patch(`${BASE}/${c.body.uuid}`, { value: 1 })).status).toBe(409);
    await client
      .patch(`${BASE}/${c.body.uuid}`, { autoRenew: true, title: 'Office lease (main)' })
      .expect(200);

    const next = await client.post(`${BASE}/${c.body.uuid}/renew`).expect(201);
    expect(next.body).toMatchObject({
      status: 'active',
      startDate: '2027-01-01',
      endDate: '2027-12-31',
      value: 12000,
      autoRenew: true,
      renewedFrom: { uuid: c.body.uuid },
    });
    const old = await client.get(`${BASE}/${c.body.uuid}`).expect(200);
    expect(old.body).toMatchObject({ status: 'renewed', renewedToUuid: next.body.uuid });
    expect((await client.post(`${BASE}/${c.body.uuid}/renew`)).status).toBe(409);

    const cancelled = await client
      .post(`${BASE}/${next.body.uuid}/cancel`, { reason: 'Moved out' })
      .expect(200);
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Moved out',
      autoRenew: false,
    });
    expect((await client.delete(`${BASE}/${next.body.uuid}`)).status).toBe(409);
  });

  it('reminds once inside the notice window, then renews or expires at the end date', async () => {
    const { client, user } = await clientWithRoles(['admin']);
    const make = async (title: string, start: string, end: string, autoRenew: boolean) => {
      const c = await client
        .post(BASE, { title, startDate: start, endDate: end, autoRenew, noticeDays: 30 })
        .expect(201);
      await client.post(`${BASE}/${c.body.uuid}/activate`).expect(200);
      return c.body.uuid as string;
    };
    const soon = await make('Ends soon', daysFromNow(-300), daysFromNow(10), false);
    const lapsed = await make('Lapsed', daysFromNow(-400), daysFromNow(-1), false);
    const rolling = await make('Rolling', daysFromNow(-400), daysFromNow(-1), true);

    const renewing = await client.get(`${BASE}?status=renewing`).expect(200);
    expect(renewing.body.data.map((x: { uuid: string }) => x.uuid)).toContain(soon);
    expect((await client.get(`${BASE}/${soon}`)).body).toMatchObject({ renewalDue: true, daysLeft: 10 });

    await runRenewals();
    await runRenewals();
    const reminders = await db('notifications').where({ user_id: user.id, type: 'contract.renewal_due' });
    expect(reminders).toHaveLength(1);
    expect((await client.get(`${BASE}/${lapsed}`)).body.status).toBe('expired');
    const rolled = await client.get(`${BASE}/${rolling}`).expect(200);
    expect(rolled.body.status).toBe('renewed');
    const successor = await client.get(`${BASE}/${rolled.body.renewedToUuid}`).expect(200);
    expect(successor.body).toMatchObject({ status: 'active', startDate: daysFromNow(0) });

    const widget = await client.get('/dashboards/widgets/module:contracts.renewals/data').expect(200);
    expect(widget.body.contracts.map((x: { uuid: string }) => x.uuid)).toContain(soon);
  });

  it('keeps contracts inside record scope', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const c = await admin.post(BASE, { title: 'Private' }).expect(201);
    const role = await createRole(['contracts.*'], { '*': 'own' });
    const { client } = await clientWithRoles([role]);
    expect((await client.get(`${BASE}/${c.body.uuid}`)).status).toBe(404);
    expect((await client.post(`${BASE}/${c.body.uuid}/activate`)).status).toBe(404);
    const list = await client.get(BASE).expect(200);
    expect(list.body.data.some((x: { uuid: string }) => x.uuid === c.body.uuid)).toBe(false);
  });
});
