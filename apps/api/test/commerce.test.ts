import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole } from './helpers';
import { db } from '../src/db/knex';
import { expireQuotes } from '../../../modules/quotes/api';

async function enable(keys: string[]) {
  const { client } = await clientWithRoles(['admin']);
  for (const k of keys) {
    const res = await client.post(`/modules/${k}/enable`);
    if (res.status !== 200) throw new Error(`enable ${k}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

describe('products and quotes', () => {
  beforeAll(async () => {
    const { client } = await clientWithRoles(['admin']);
    // Quotes depend on products.
    expect((await client.post('/modules/quotes/enable')).body.error.code).toBe('MODULE_DEPENDENCY');
    await enable(['products', 'quotes']);
  });

  it('manages the product catalog with unique SKUs', async () => {
    const { client } = await clientWithRoles(['admin']);
    const p = await client
      .post('/m/products/products', { sku: 'DESK-1', name: 'Hot desk day pass', unitPrice: 25, taxRate: 20 })
      .expect(201);
    expect(p.body).toMatchObject({ sku: 'DESK-1', unitPrice: 25, taxRate: 20, active: true });
    expect(
      (await client.post('/m/products/products', { sku: 'DESK-1', name: 'Dup', unitPrice: 1 })).status,
    ).toBe(409);
    await client.patch(`/m/products/products/${p.body.uuid}`, { active: false }).expect(200);
    const active = await client.get('/m/products/products?q=desk').expect(200);
    expect(active.body.data.some((x: { uuid: string }) => x.uuid === p.body.uuid)).toBe(false);
    const all = await client.get('/m/products/products?q=desk&active=all').expect(200);
    expect(all.body.data.some((x: { uuid: string }) => x.uuid === p.body.uuid)).toBe(true);
  });

  it('computes totals on the server, numbers quotes, and follows the status flow', async () => {
    const { client } = await clientWithRoles(['admin']);
    const product = await client
      .post('/m/products/products', { name: 'Consulting hour', unitPrice: 150, taxRate: 20 })
      .expect(201);
    const org = await client.post('/organizations', { name: 'Quote Buyer Ltd' }).expect(201);
    const deal = await client
      .post('/deals', { title: 'Big project', organizationUuid: org.body.uuid })
      .expect(201);

    const empty = await client.post('/m/quotes/quotes', { title: 'Empty' }).expect(201);
    expect((await client.post(`/m/quotes/quotes/${empty.body.uuid}/send`)).status).toBe(422);

    const q = await client
      .post('/m/quotes/quotes', {
        title: 'Project proposal',
        organizationUuid: org.body.uuid,
        dealUuid: deal.body.uuid,
        lines: [
          {
            productUuid: product.body.uuid,
            name: 'Consulting hour',
            quantity: 10,
            unitPrice: 150,
            discountPct: 10,
            taxRate: 20,
          },
          { name: 'Travel', quantity: 1, unitPrice: 99.99 },
        ],
        // Client-sent totals are ignored.
        total: 1,
      })
      .expect(201);
    expect(q.body.number).toMatch(/^Q-\d{4}$/);
    expect(q.body).toMatchObject({
      status: 'draft',
      subtotal: 1599.99,
      discountTotal: 150,
      taxTotal: 270,
      total: 1719.99,
      organization: { uuid: org.body.uuid, name: 'Quote Buyer Ltd' },
      deal: { uuid: deal.body.uuid },
    });
    expect(q.body.lines).toHaveLength(2);
    expect(q.body.lines[0].productUuid).toBe(product.body.uuid);
    expect(q.body.taxes).toEqual([{ rate: 20, net: 1350, tax: 270 }]);
    expect(q.body.validUntil > q.body.issueDate).toBe(true);
    expect(Number(q.body.number.slice(2))).toBe(Number(empty.body.number.slice(2)) + 1);

    const byDeal = await client.get(`/m/quotes/quotes?dealUuid=${deal.body.uuid}`).expect(200);
    expect(byDeal.body.data.map((x: { uuid: string }) => x.uuid)).toEqual([q.body.uuid]);

    await client.post(`/m/quotes/quotes/${q.body.uuid}/send`).expect(200);
    expect((await client.patch(`/m/quotes/quotes/${q.body.uuid}`, { title: 'x' })).status).toBe(409);
    await client.post(`/m/quotes/quotes/${q.body.uuid}/revise`).expect(200);
    await client
      .patch(`/m/quotes/quotes/${q.body.uuid}`, {
        lines: [{ name: 'Flat fee', quantity: 1, unitPrice: 1000 }],
      })
      .expect(200);
    await client.post(`/m/quotes/quotes/${q.body.uuid}/send`).expect(200);
    const accepted = await client
      .post(`/m/quotes/quotes/${q.body.uuid}/accept`, { acceptedByName: 'Pat Buyer' })
      .expect(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', acceptedByName: 'Pat Buyer', total: 1000 });
    expect((await client.delete(`/m/quotes/quotes/${q.body.uuid}`)).status).toBe(409);

    const copy = await client.post(`/m/quotes/quotes/${q.body.uuid}/duplicate`).expect(201);
    expect(copy.body).toMatchObject({ status: 'draft', total: 1000, title: 'Project proposal' });
    expect(copy.body.number).not.toBe(q.body.number);
    await client.delete(`/m/quotes/quotes/${copy.body.uuid}`).expect(204);
    expect((await client.get(`/m/quotes/quotes/${copy.body.uuid}`)).status).toBe(404);

    const audits = await db('audit_logs').where({ entity_uuid: q.body.uuid }).pluck('action');
    expect(audits).toEqual(
      expect.arrayContaining([
        'quotes.quote.created',
        'quotes.quote.sent',
        'quotes.quote.revised',
        'quotes.quote.accepted',
      ]),
    );
  });

  it('applies record scope to quotes and to the records they link', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const others = await admin.post('/m/quotes/quotes', { title: 'Not yours' }).expect(201);
    const hiddenOrg = await admin.post('/organizations', { name: 'Hidden org' }).expect(201);

    const role = await createRole(['quotes.quotes.*', 'core.organizations.view'], { '*': 'own' });
    const { client } = await clientWithRoles([role]);
    expect((await client.get(`/m/quotes/quotes/${others.body.uuid}`)).status).toBe(404);
    expect((await client.patch(`/m/quotes/quotes/${others.body.uuid}`, { title: 'mine now' })).status).toBe(
      404,
    );
    const list = await client.get('/m/quotes/quotes').expect(200);
    expect(list.body.data.some((x: { uuid: string }) => x.uuid === others.body.uuid)).toBe(false);
    // Linking a record outside your scope looks exactly like linking a missing one.
    const linked = await client.post('/m/quotes/quotes', { organizationUuid: hiddenOrg.body.uuid });
    expect(linked.status).toBe(422);
    const mine = await client.post('/m/quotes/quotes', { title: 'Mine' }).expect(201);
    expect((await client.get(`/m/quotes/quotes/${mine.body.uuid}`)).status).toBe(200);
    // Cannot hand a quote to someone outside your scope.
    const { user: stranger } = await clientWithRoles(['admin']);
    expect(
      (await client.patch(`/m/quotes/quotes/${mine.body.uuid}`, { ownerUuid: stranger.uuid })).status,
    ).toBe(403);
  });

  it('expires sent quotes past their validity date', async () => {
    const { client } = await clientWithRoles(['admin']);
    const q = await client
      .post('/m/quotes/quotes', {
        lines: [{ name: 'Item', quantity: 1, unitPrice: 10 }],
        validUntil: '2020-01-01',
      })
      .expect(201);
    await client.post(`/m/quotes/quotes/${q.body.uuid}/send`).expect(200);
    await expireQuotes();
    expect((await client.get(`/m/quotes/quotes/${q.body.uuid}`)).body.status).toBe('expired');
    // An expired quote can still be accepted if the customer comes back.
    await client.post(`/m/quotes/quotes/${q.body.uuid}/accept`).expect(200);
  });
});
