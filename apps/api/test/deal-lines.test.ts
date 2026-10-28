import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, unique, type Client } from './helpers';

describe('deal line items and record panels', () => {
  let admin: Client;

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    await admin.post('/modules/products/enable').expect(200);
  });

  it('lists the products panel for deals in the bootstrap', async () => {
    const boot = await admin.get('/meta/bootstrap').expect(200);
    expect(boot.body.modules.panels).toContainEqual(
      expect.objectContaining({ moduleKey: 'products', key: 'deal-lines', entity: 'deal' }),
    );
  });

  it('saves lines with server totals and can set the deal value', async () => {
    const product = await admin
      .post('/m/products/products', { name: unique('Widget'), unitPrice: 50 })
      .expect(201);
    const deal = await admin.post('/deals', { title: unique('Lines'), value: 1 }).expect(201);
    const res = await admin
      .put(`/m/products/deals/${deal.body.uuid}/lines`, {
        lines: [
          { productUuid: product.body.uuid, name: 'Widget', quantity: 3, unitPrice: 50, taxRate: 10 },
          { name: 'Setup', quantity: 1, unitPrice: 100, discountPct: 50 },
        ],
        applyToValue: true,
      })
      .expect(200);
    expect(res.body.totals.total).toBe(3 * 50 * 1.1 + 50);
    expect(res.body.dealValue).toBe(res.body.totals.total);
    const read = await admin.get(`/m/products/deals/${deal.body.uuid}/lines`).expect(200);
    expect(read.body.lines).toHaveLength(2);
  });

  it('applies deal scope and permissions', async () => {
    const deal = await admin.post('/deals', { title: unique('Theirs') }).expect(201);
    const viewer = await loginAs(
      await createUser({
        roleKeys: [await createRole(['core.deals.view', 'products.products.view'], { 'core.deals': 'own' })],
      }),
    );
    await viewer.get(`/m/products/deals/${deal.body.uuid}/lines`).expect(404);
    const reader = await loginAs(
      await createUser({
        roleKeys: [await createRole(['core.deals.view', 'products.products.view'], { 'core.deals': 'all' })],
      }),
    );
    await reader.get(`/m/products/deals/${deal.body.uuid}/lines`).expect(200);
    await reader.put(`/m/products/deals/${deal.body.uuid}/lines`, { lines: [] }).expect(403);
  });
});
