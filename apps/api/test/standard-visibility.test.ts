import { afterAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole } from './helpers';
import { db } from '../src/db/knex';
import { clearStandardVisibilityCache } from '../src/core/custom-fields/standard-visibility';

describe('standard field visibility', () => {
  afterAll(async () => {
    await db('standard_field_visibility').delete();
    clearStandardVisibilityCache();
  });

  it('keeps a hidden deal value and contact email out of every response, and refuses writes', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const role = await createRole(
      ['core.deals.*', 'core.contacts.*', 'core.reports.view', 'core.dashboard.view', 'core.activities.view'],
      { '*': 'all' },
    );
    const SECRET = 987654;
    const EMAIL = `hidden-${Date.now()}@example.test`;
    await admin
      .put('/custom-fields/standard/deal/value', {
        visibility: { default: 'write', roles: { [role]: 'hidden' } },
      })
      .expect(200);
    await admin
      .put('/custom-fields/standard/contact/email', {
        visibility: { default: 'write', roles: { [role]: 'hidden' } },
      })
      .expect(200);
    await admin
      .put('/custom-fields/standard/contact/job_title', {
        visibility: { default: 'write', roles: { [role]: 'read' } },
      })
      .expect(200);
    await admin
      .put('/custom-fields/standard/contact/title', { visibility: { default: 'hidden', roles: {} } })
      .expect(422);

    const deal = await admin
      .post('/deals', { title: `Secret value deal ${Date.now()}`, value: SECRET })
      .expect(201);
    const contact = await admin
      .post('/contacts', { firstName: 'Hidden', lastName: 'Mail', email: EMAIL, jobTitle: 'Buyer' })
      .expect(201);
    await admin.patch(`/deals/${deal.body.uuid}`, { value: SECRET + 1 }).expect(200);

    const { client } = await clientWithRoles([role]);
    const leaks: string[] = [];
    const check = (label: string, body: unknown) => {
      const text = JSON.stringify(body);
      if (text.includes(String(SECRET)) || text.includes(String(SECRET + 1))) leaks.push(`${label}: value`);
      if (text.toLowerCase().includes(EMAIL)) leaks.push(`${label}: email`);
    };

    const boot = await client.get('/meta/bootstrap').expect(200);
    expect(boot.body.standardFields).toEqual({
      contact: { email: 'hidden', job_title: 'read' },
      deal: { value: 'hidden' },
    });
    check('deal detail', (await client.get(`/deals/${deal.body.uuid}`).expect(200)).body);
    check('deal list', (await client.get('/deals?pageSize=100').expect(200)).body);
    const board = await client.get('/deals/board').expect(200);
    check('board', board.body);
    check('timeline', (await client.get(`/deals/${deal.body.uuid}/timeline`).expect(200)).body);
    check('contact detail', (await client.get(`/contacts/${contact.body.uuid}`).expect(200)).body);
    check('contact export', (await client.get('/contacts/export').expect(200)).text);
    check('deal export', (await client.get('/deals/export').expect(200)).text);
    const search = await client.get(`/search?q=${encodeURIComponent(EMAIL)}`).expect(200);
    expect(search.body.data.filter((h: { type: string }) => h.type === 'contact')).toHaveLength(0);
    check('search by name', (await client.get('/search?q=Hidden%20Mail').expect(200)).body);
    const pipeline = await client.get('/dashboards/widgets/pipeline_value/data').expect(200);
    expect(pipeline.body.total).toBeNull();
    check('pipeline widget', pipeline.body);
    await client.get('/reports/forecast').expect(403);
    await client
      .post('/reports/custom/preview', {
        entity: 'deal',
        groupBy: 'status',
        metric: 'sum',
        metricField: 'value',
      })
      .expect(422);
    expect(leaks).toEqual([]);

    // Hidden fields cannot be filtered or sorted on (no probing), nor written.
    const f = encodeURIComponent(JSON.stringify({ field: 'value', op: 'gt', value: 1 }));
    await client.get(`/deals?filter=${f}`).expect(422);
    await client.get('/deals?sort=-value').expect(422);
    await client.patch(`/deals/${deal.body.uuid}`, { value: 1 }).expect(403);
    await client.post('/contacts', { firstName: 'X', email: 'x@example.test' }).expect(403);
    // Read-only: unchanged values may be sent back, a change is refused.
    await client.patch(`/contacts/${contact.body.uuid}`, { jobTitle: 'Buyer', firstName: 'Hid' }).expect(200);
    await client.patch(`/contacts/${contact.body.uuid}`, { jobTitle: 'Boss' }).expect(403);
    // Admins still see everything.
    expect((await admin.get(`/deals/${deal.body.uuid}`).expect(200)).body.value).toBe(SECRET + 1);
  });
});
