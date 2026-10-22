import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, type Client } from './helpers';

const A = '/m/assets/assets';
const S = '/m/assets/stock';

describe('assets and stock', () => {
  let admin: Client;
  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    await admin.post('/modules/assets/enable').expect(200);
  });

  it('lends and returns assets with a history, and refuses double lending', async () => {
    const c = await admin.post('/contacts', { firstName: 'Lena', lastName: 'Loan' }).expect(201);
    const key = await admin.post(A, { tag: 'KEY-014', name: 'Office key 14', category: 'Keys' }).expect(201);
    expect((await admin.post(A, { tag: 'KEY-014', name: 'Dup' })).status).toBe(409);
    const lent = await admin
      .post(`${A}/${key.body.uuid}/assign`, { contactUuid: c.body.uuid, dueBack: '2020-01-01' })
      .expect(200);
    expect(lent.body).toMatchObject({ status: 'assigned', assignedTo: { uuid: c.body.uuid }, overdue: true });
    expect((await admin.post(`${A}/${key.body.uuid}/assign`, { contactUuid: c.body.uuid })).status).toBe(409);
    expect((await admin.post(`${A}/${key.body.uuid}/status`, { status: 'retired' })).status).toBe(409);
    const overdue = await admin.get(`${A}?status=overdue`).expect(200);
    expect(overdue.body.data.map((a: { uuid: string }) => a.uuid)).toContain(key.body.uuid);
    const byContact = await admin.get(`${A}?contactUuid=${c.body.uuid}`).expect(200);
    expect(byContact.body.data).toHaveLength(1);

    const back = await admin
      .post(`${A}/${key.body.uuid}/return`, { needsMaintenance: true, note: 'Bent' })
      .expect(200);
    expect(back.body).toMatchObject({ status: 'maintenance', assignedTo: null });
    await admin.post(`${A}/${key.body.uuid}/status`, { status: 'available' }).expect(200);
    const detail = await admin.get(`${A}/${key.body.uuid}`).expect(200);
    expect(detail.body.history.map((h: { kind: string }) => h.kind)).toEqual([
      'available',
      'returned',
      'assigned',
      'created',
    ]);
  });

  it('tracks stock movements, refuses negative stock, and flags low stock once', async () => {
    const item = await admin
      .post(S, { name: 'Coffee beans', unit: 'kg', quantity: 10, reorderLevel: 3 })
      .expect(201);
    expect(item.body).toMatchObject({ quantity: 10, low: false });
    expect((await admin.post(`${S}/${item.body.uuid}/movements`, { kind: 'out', quantity: 11 })).status).toBe(
      422,
    );
    const out = await admin
      .post(`${S}/${item.body.uuid}/movements`, { kind: 'out', quantity: 7.5, reason: 'Kitchen' })
      .expect(200);
    expect(out.body).toMatchObject({ quantity: 2.5, low: true });
    const low = await admin.get(`${S}?low=true`).expect(200);
    expect(low.body.data.map((s: { uuid: string }) => s.uuid)).toContain(item.body.uuid);
    const counted = await admin
      .post(`${S}/${item.body.uuid}/movements`, { kind: 'adjust', quantity: 12 })
      .expect(200);
    expect(counted.body).toMatchObject({ quantity: 12, low: false });
    const detail = await admin.get(`${S}/${item.body.uuid}`).expect(200);
    expect(
      detail.body.movements.map((m: { kind: string; balanceAfter: number }) => [m.kind, m.balanceAfter]),
    ).toEqual([
      ['adjust', 12],
      ['out', 2.5],
      ['in', 10],
    ]);
    const widget = await admin.get('/dashboards/widgets/module:assets.overview/data').expect(200);
    expect(widget.body).toHaveProperty('lowStock');
  });

  it('separates viewing from managing', async () => {
    const role = await createRole(['assets.assets.view']);
    const { client } = await clientWithRoles([role]);
    await client.get(A).expect(200);
    expect((await client.post(A, { tag: 'X-1', name: 'Nope' })).status).toBe(403);
    expect((await client.post(S, { name: 'Nope' })).status).toBe(403);
  });
});
