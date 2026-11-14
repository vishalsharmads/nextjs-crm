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

  it('closes the side doors: list search, duplicates, merge, forecast, audit, conversion, write probing', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    await admin.patch('/settings/features', { leads: true }).expect(200);
    const role = await createRole(
      [
        'core.deals.*',
        'core.contacts.*',
        'core.leads.*',
        'core.organizations.view',
        'core.reports.view',
        'core.audit.view',
      ],
      { '*': 'all' },
    );
    await admin
      .put('/custom-fields/standard/contact/email', {
        visibility: { default: 'write', roles: { [role]: 'hidden' } },
      })
      .expect(200);
    await admin
      .put('/custom-fields/standard/deal/value', {
        visibility: { default: 'write', roles: { [role]: 'read' } },
      })
      .expect(200);
    await admin
      .put('/custom-fields/standard/deal/expected_close', {
        visibility: { default: 'write', roles: { [role]: 'hidden' } },
      })
      .expect(200);
    const EMAIL = `side-${Date.now()}@example.test`;
    const onlyEmail = await admin.post('/contacts', { email: EMAIL }).expect(201);
    const other = await admin.post('/contacts', { firstName: 'Twin', email: EMAIL }).expect(201);
    await admin.patch(`/contacts/${onlyEmail.body.uuid}`, { email: `x.${EMAIL}` }).expect(200);
    await admin.patch(`/contacts/${onlyEmail.body.uuid}`, { email: EMAIL }).expect(200);

    const { client } = await clientWithRoles([role]);
    const leak = (body: unknown) => JSON.stringify(body).toLowerCase().includes(EMAIL);
    // A name that falls back to the email does not show it.
    expect(leak((await client.get(`/contacts/${onlyEmail.body.uuid}`).expect(200)).body)).toBe(false);
    // List search does not match on the hidden email.
    const found = await client.get(`/contacts?q=${encodeURIComponent(EMAIL)}`).expect(200);
    expect(found.body.data).toHaveLength(0);
    // Duplicate checks neither compare nor show it.
    const dup = await client.post('/contacts/check-duplicates', { email: EMAIL }).expect(200);
    expect(dup.body.data).toHaveLength(0);
    const dupOf = await client.get(`/contacts/${other.body.uuid}/duplicates`).expect(200);
    expect(leak(dupOf.body)).toBe(false);
    // Writing a guess is refused whatever the stored value: nothing to compare against.
    await client.patch(`/contacts/${onlyEmail.body.uuid}`, { email: EMAIL }).expect(403);
    // Merging cannot pick the hidden email.
    await client
      .post('/contacts/merge', {
        primaryUuid: onlyEmail.body.uuid,
        secondaryUuids: [other.body.uuid],
        pick: { email: other.body.uuid },
      })
      .expect(403);
    // Audit diffs leave the hidden columns out.
    expect(leak((await client.get(`/audit-logs?entityUuid=${onlyEmail.body.uuid}`).expect(200)).body)).toBe(
      false,
    );
    // Forecast buckets by the hidden expected close date.
    await client.get('/reports/forecast').expect(403);
    // A read-only value: deals can still be created (the default is not a choice) and saved unchanged.
    const deal = await client.post('/deals', { title: 'Read-only value' }).expect(201);
    await client.patch(`/deals/${deal.body.uuid}`, { value: 0, title: 'Renamed' }).expect(200);
    await client.patch(`/deals/${deal.body.uuid}`, { value: 10 }).expect(403);
    // Converting a lead does not copy what the person may not write on the contact.
    const lead = await admin.post('/leads', { firstName: 'Conv', email: `lead-${EMAIL}` }).expect(201);
    const conv = await client.post(`/leads/${lead.body.uuid}/convert`, {}).expect(200);
    const row = await db('contacts').where({ uuid: conv.body.contactUuid }).first('email');
    expect(row.email).toBeNull();
  });
});
