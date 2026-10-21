import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole } from './helpers';
import { db } from '../src/db/knex';
import { flagOverdueInvoices } from '../../../modules/invoices/api';

const BASE = '/m/invoices/invoices';
const line = (unitPrice: number, quantity = 1, taxRate = 0) => ({
  name: 'Item',
  quantity,
  unitPrice,
  taxRate,
});

describe('invoices and payments', () => {
  beforeAll(async () => {
    const { client } = await clientWithRoles(['admin']);
    for (const k of ['products', 'quotes', 'invoices']) {
      const res = await client.post(`/modules/${k}/enable`);
      if (res.status !== 200) throw new Error(`enable ${k}: ${JSON.stringify(res.body)}`);
    }
  });

  it('issues an invoice, takes payments until paid, and locks it', async () => {
    const { client } = await clientWithRoles(['admin']);
    const inv = await client.post(BASE, { title: 'October', lines: [line(100, 2, 10)] }).expect(201);
    expect(inv.body).toMatchObject({ status: 'draft', total: 220, balanceDue: 220 });
    expect(inv.body.number).toMatch(/^INV-\d{4}$/);
    expect(inv.body.dueDate > inv.body.issueDate).toBe(true);

    expect((await client.post(`${BASE}/${inv.body.uuid}/payments`, { amount: 10 })).status).toBe(409);
    await client.post(`${BASE}/${inv.body.uuid}/issue`).expect(200);
    expect((await client.patch(`${BASE}/${inv.body.uuid}`, { title: 'x' })).status).toBe(409);
    expect((await client.delete(`${BASE}/${inv.body.uuid}`)).status).toBe(409);

    const part = await client
      .post(`${BASE}/${inv.body.uuid}/payments`, { amount: 120.1, method: 'card', reference: 'ch_1' })
      .expect(201);
    expect(part.body).toMatchObject({ status: 'partially_paid', amountPaid: 120.1, balanceDue: 99.9 });
    const over = await client.post(`${BASE}/${inv.body.uuid}/payments`, { amount: 100 });
    expect(over.status).toBe(422);
    const paid = await client.post(`${BASE}/${inv.body.uuid}/payments`, { amount: 99.9 }).expect(201);
    expect(paid.body).toMatchObject({ status: 'paid', balanceDue: 0 });
    expect(paid.body.payments).toHaveLength(2);

    // Removing a payment reopens the invoice.
    await client.delete(`${BASE}/${inv.body.uuid}/payments/${paid.body.payments[1].uuid}`).expect(204);
    const reopened = await client.get(`${BASE}/${inv.body.uuid}`).expect(200);
    expect(reopened.body).toMatchObject({ status: 'partially_paid', balanceDue: 99.9 });
    // Cannot void while payments exist.
    expect((await client.post(`${BASE}/${inv.body.uuid}/void`, { reason: 'Wrong' })).status).toBe(409);

    const actions = await db('audit_logs').where('action', 'like', 'invoices.%').pluck('action');
    expect(actions).toEqual(
      expect.arrayContaining([
        'invoices.invoice.created',
        'invoices.invoice.issued',
        'invoices.payment.recorded',
        'invoices.payment.removed',
      ]),
    );
  });

  it('voids issued invoices and only deletes drafts', async () => {
    const { client } = await clientWithRoles(['admin']);
    const draft = await client.post(BASE, { lines: [line(5)] }).expect(201);
    await client.delete(`${BASE}/${draft.body.uuid}`).expect(204);
    const inv = await client.post(BASE, { lines: [line(5)] }).expect(201);
    await client.post(`${BASE}/${inv.body.uuid}/issue`).expect(200);
    const voided = await client.post(`${BASE}/${inv.body.uuid}/void`, { reason: 'Duplicate' }).expect(200);
    expect(voided.body).toMatchObject({ status: 'void', voidReason: 'Duplicate', balanceDue: 0 });
    expect((await client.post(`${BASE}/${inv.body.uuid}/payments`, { amount: 1 })).status).toBe(409);
  });

  it('converts an accepted quote into an invoice exactly once', async () => {
    const { client } = await clientWithRoles(['admin']);
    const org = await client.post('/organizations', { name: 'Invoice Co' }).expect(201);
    const q = await client
      .post('/m/quotes/quotes', { organizationUuid: org.body.uuid, lines: [line(250, 2, 20)] })
      .expect(201);
    expect((await client.post(`${BASE}/from-quote/${q.body.uuid}`)).status).toBe(409);
    await client.post(`/m/quotes/quotes/${q.body.uuid}/send`).expect(200);
    await client.post(`/m/quotes/quotes/${q.body.uuid}/accept`).expect(200);
    const inv = await client.post(`${BASE}/from-quote/${q.body.uuid}`).expect(201);
    expect(inv.body).toMatchObject({
      status: 'draft',
      total: 600,
      sourceQuoteUuid: q.body.uuid,
      organization: { uuid: org.body.uuid },
    });
    expect(inv.body.lines).toHaveLength(1);
    expect((await client.post(`${BASE}/from-quote/${q.body.uuid}`)).status).toBe(409);
    expect((await client.get(`/m/quotes/quotes/${q.body.uuid}`)).body.convertedInvoiceUuid).toBe(
      inv.body.uuid,
    );
    const byOrg = await client.get(`${BASE}?organizationUuid=${org.body.uuid}`).expect(200);
    expect(byOrg.body.data.map((x: { uuid: string }) => x.uuid)).toEqual([inv.body.uuid]);
  });

  it('flags overdue invoices once and reports receivables within scope', async () => {
    const { client, user } = await clientWithRoles(['admin']);
    const inv = await client
      .post(BASE, { lines: [line(40)], issueDate: '2020-01-01', dueDate: '2020-01-15', currency: 'EUR' })
      .expect(201);
    await client.post(`${BASE}/${inv.body.uuid}/issue`).expect(200);
    expect((await client.get(`${BASE}/${inv.body.uuid}`)).body.overdue).toBe(true);
    const overdue = await client.get(`${BASE}?status=overdue`).expect(200);
    expect(overdue.body.data.some((x: { uuid: string }) => x.uuid === inv.body.uuid)).toBe(true);

    await flagOverdueInvoices();
    await flagOverdueInvoices();
    const notes = await db('notifications').where({ user_id: user.id, type: 'invoice.overdue' });
    expect(notes).toHaveLength(1);

    const widget = await client.get('/dashboards/widgets/module:invoices.receivables/data').expect(200);
    const eur = widget.body.totals.find((t: { currency: string }) => t.currency === 'EUR');
    expect(eur.overdue).toBeGreaterThanOrEqual(40);

    // Own scope: another user's invoices are invisible, including to payments.
    const role = await createRole(['invoices.*', 'core.dashboard.view'], { '*': 'own' });
    const { client: rep } = await clientWithRoles([role]);
    expect((await rep.get(`${BASE}/${inv.body.uuid}`)).status).toBe(404);
    expect((await rep.post(`${BASE}/${inv.body.uuid}/payments`, { amount: 1 })).status).toBe(404);
    const repWidget = await rep.get('/dashboards/widgets/module:invoices.receivables/data').expect(200);
    expect(repWidget.body.totals).toEqual([]);
  });
});
