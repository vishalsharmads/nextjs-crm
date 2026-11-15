import { afterAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, restoreSettingsAfterEach } from './helpers';
import { db } from '../src/db/knex';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Tests here turn on the leads feature: put the setting back for other files.
restoreSettingsAfterEach(['features']);

describe('duplicate rules', () => {
  afterAll(async () => {
    // Leave the starter rules as they were for other files.
    await db('duplicate_rules').update({ action: 'warn', active: true });
  });

  it('warns about visible matches and counts hidden ones without describing them', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const other = await createUser({ roleKeys: ['sales_rep'] });
    const email = `dup-${uid()}@example.test`;
    const theirs = await admin
      .post('/contacts', { firstName: 'Ana', email, ownerUuid: other.uuid })
      .expect(201);
    // A rep with own scope sees nothing of the match, only that one exists.
    const rep = await createUser({ roleKeys: ['sales_rep'] });
    const repClient = await loginAs(rep);
    const check = await repClient
      .post('/contacts/check-duplicates', { email: email.toUpperCase() })
      .expect(200);
    expect(check.body).toEqual({ data: [], hidden: 1, blocked: false });
    const adminCheck = await admin.post('/contacts/check-duplicates', { email }).expect(200);
    expect(adminCheck.body.data[0].uuid).toBe(theirs.body.uuid);
    expect(adminCheck.body.data[0].reasons).toEqual(['Same email']);
  });

  it('blocks a create when a blocking rule matches, also for someone who cannot see the match', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const rules = (await admin.get('/duplicates/rules').expect(200)).body.data as {
      uuid: string;
      entity: string;
      name: string;
    }[];
    const emailRule = rules.find((r) => r.entity === 'contact' && r.name === 'Same email')!;
    await admin.patch(`/duplicates/rules/${emailRule.uuid}`, { action: 'block' }).expect(200);
    const email = `block-${uid()}@example.test`;
    await admin.post('/contacts', { firstName: 'Bo', email }).expect(201);
    const rep = await createUser({ roleKeys: ['sales_rep'] });
    const res = await (await loginAs(rep)).post('/contacts', { firstName: 'Bo', email }).expect(409);
    expect(res.body.error.message).toContain('Same email');
    expect(JSON.stringify(res.body)).not.toContain('"uuid"');
    await admin.patch(`/duplicates/rules/${emailRule.uuid}`, { action: 'warn' }).expect(200);
    await admin.post('/contacts', { firstName: 'Bo', email }).expect(201);
  });

  it('flags a new lead whose email belongs to a contact', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    await admin.patch('/settings/features', { leads: true }).expect(200);
    const email = `lead-${uid()}@example.test`;
    const contact = await admin.post('/contacts', { firstName: 'Cy', email }).expect(201);
    const res = await admin.post('/leads/check-duplicates', { email }).expect(200);
    expect(res.body.data).toContainEqual(
      expect.objectContaining({ uuid: contact.body.uuid, entity: 'contact' }),
    );
  });

  it('only accepts filterable, non-sensitive custom fields and is for settings managers', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    await admin
      .post('/duplicates/rules', { entity: 'contact', name: 'Bad', fields: ['cf:does_not_exist'] })
      .expect(422);
    const created = await admin
      .post('/duplicates/rules', {
        entity: 'organization',
        name: 'Same name only',
        fields: ['name'],
        action: 'warn',
      })
      .expect(201);
    expect(created.body.fields).toEqual(['name']);
    const role = await createRole(['core.contacts.view'], { '*': 'all' });
    const { client } = await clientWithRoles([role]);
    await client.get('/duplicates/rules').expect(403);
    await admin.delete(`/duplicates/rules/${created.body.uuid}`).expect(204);
  });

  it('scans pairs into the merge queue; merging or dismissing closes them', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const phone = `+44 20 7946 ${Math.floor(1000 + Math.random() * 8999)}`;
    const a = await admin.post('/contacts', { firstName: 'Dee', phone }).expect(201);
    const b = await admin.post('/contacts', { firstName: 'Dee', phone }).expect(201);
    const c = await admin.post('/contacts', { firstName: 'Dee', phone }).expect(201);
    const scan = await admin.post('/duplicates/scan').expect(200);
    expect(scan.body.added).toBeGreaterThanOrEqual(3);
    const mine = (pairs: { uuid: string; a: { uuid: string }; b: { uuid: string } }[]) =>
      pairs.filter((p) => [a, b, c].some((x) => x.body.uuid === p.a.uuid || x.body.uuid === p.b.uuid));
    let pairs = mine((await admin.get('/duplicates/pairs?entity=contact').expect(200)).body.data);
    expect(pairs).toHaveLength(3);

    // A rep without merge permission sees no queue.
    const rep = await createUser({ roleKeys: ['sales_rep'] });
    const repPairs = (await (await loginAs(rep)).get('/duplicates/pairs').expect(200)).body.data;
    expect(mine(repPairs)).toHaveLength(0);

    await admin
      .post('/contacts/merge', { primaryUuid: a.body.uuid, secondaryUuids: [b.body.uuid] })
      .expect(200);
    pairs = mine((await admin.get('/duplicates/pairs?entity=contact').expect(200)).body.data);
    expect(pairs).toHaveLength(1);
    await admin.post(`/duplicates/pairs/${pairs[0]!.uuid}/dismiss`).expect(204);
    expect(mine((await admin.get('/duplicates/pairs').expect(200)).body.data)).toHaveLength(0);
    // A second scan does not bring a dismissed pair back.
    await admin.post('/duplicates/scan').expect(200);
    expect(mine((await admin.get('/duplicates/pairs').expect(200)).body.data)).toHaveLength(0);
  });
});
