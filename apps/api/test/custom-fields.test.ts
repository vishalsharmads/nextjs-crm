import { describe, expect, it } from 'vitest';
import { clientWithRoles, createRole } from './helpers';
import { db } from '../src/db/knex';

describe('custom fields', () => {
  it('creates a filterable field, validates values, and filters and sorts by it', async () => {
    const { client } = await clientWithRoles(['admin']);
    const field = await client
      .post('/custom-fields', {
        entity: 'contact',
        key: 'tier',
        label: 'Tier',
        type: 'select',
        filterable: true,
        options: [
          { key: 'gold', label: 'Gold' },
          { key: 'silver', label: 'Silver' },
        ],
      })
      .expect(201);
    expect(field.body.filterable).toBe(true);
    const cols = await db('information_schema.columns').where({
      table_schema: db.raw('DATABASE()'),
      table_name: 'contacts',
      column_name: 'cf_tier',
    });
    expect(cols).toHaveLength(1);

    await client.post('/contacts', { firstName: 'Gia', custom: { tier: 'platinum' } }).expect(422);
    await client.post('/contacts', { firstName: 'Gia', custom: { nope: 1 } }).expect(422);
    const gold = await client
      .post('/contacts', { firstName: 'Gia', lastName: 'Gold', custom: { tier: 'gold' } })
      .expect(201);
    expect(gold.body.custom).toEqual({ tier: 'gold' });
    await client
      .post('/contacts', { firstName: 'Sal', lastName: 'Silver', custom: { tier: 'silver' } })
      .expect(201);

    const filter = encodeURIComponent(JSON.stringify({ field: 'cf.tier', op: 'eq', value: 'gold' }));
    const res = await client.get(`/contacts?filter=${filter}`).expect(200);
    expect(res.body.data.every((c: { custom: { tier?: string } }) => c.custom.tier === 'gold')).toBe(true);
    expect(res.body.data.some((c: { uuid: string }) => c.uuid === gold.body.uuid)).toBe(true);
    await client.get('/contacts?sort=-cf.tier').expect(200);

    // Clearing a value removes the key rather than storing null.
    const cleared = await client.patch(`/contacts/${gold.body.uuid}`, { custom: { tier: null } }).expect(200);
    expect(cleared.body.custom).toEqual({});
    const raw = await db('contacts').where({ uuid: gold.body.uuid }).first('custom');
    expect(raw.custom).toEqual({});
  });

  it('supports multi-select filtering through the multi-valued index', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client
      .post('/custom-fields', {
        entity: 'organization',
        key: 'segments',
        label: 'Segments',
        type: 'multi_select',
        filterable: true,
        options: [
          { key: 'smb', label: 'SMB' },
          { key: 'ent', label: 'Enterprise' },
        ],
      })
      .expect(201);
    const org = await client
      .post('/organizations', { name: 'Multi Co', custom: { segments: ['smb', 'ent'] } })
      .expect(201);
    await client.post('/organizations', { name: 'Empty Co', custom: { segments: [] } }).expect(201);
    const filter = encodeURIComponent(JSON.stringify({ field: 'cf.segments', op: 'in', value: ['ent'] }));
    const res = await client.get(`/organizations?filter=${filter}`).expect(200);
    expect(res.body.data.map((o: { uuid: string }) => o.uuid)).toContain(org.body.uuid);
    expect(
      res.body.data.every((o: { custom: { segments?: string[] } }) => o.custom.segments?.includes('ent')),
    ).toBe(true);
  });

  it('enforces required fields on create and field visibility per role', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const role = await createRole(['core.deals.*', 'core.contacts.*'], { '*': 'all' });
    await admin
      .post('/custom-fields', {
        entity: 'deal',
        key: 'margin',
        label: 'Margin',
        type: 'decimal',
        visibility: { default: 'write', roles: { [role]: 'hidden' } },
      })
      .expect(201);
    const po = await admin
      .post('/custom-fields', {
        entity: 'deal',
        key: 'po_number',
        label: 'PO number',
        type: 'text',
        required: true,
        visibility: { default: 'write', roles: { [role]: 'read' } },
      })
      .expect(201);

    await admin.post('/deals', { title: 'Missing PO' }).expect(422);
    const deal = await admin
      .post('/deals', { title: 'Has PO', custom: { po_number: 'PO-1', margin: 0.4 } })
      .expect(201);

    const { client } = await clientWithRoles([role]);
    const seen = await client.get(`/deals/${deal.body.uuid}`).expect(200);
    expect(seen.body.custom).toEqual({ po_number: 'PO-1' });
    // Read-only and hidden fields cannot be written; the required read-only field does not block creation.
    expect(
      (await client.patch(`/deals/${deal.body.uuid}`, { custom: { po_number: 'PO-2' } })).body.error.code,
    ).toBe('FIELD_FORBIDDEN');
    expect((await client.patch(`/deals/${deal.body.uuid}`, { custom: { margin: 1 } })).body.error.code).toBe(
      'FIELD_FORBIDDEN',
    );
    await client.post('/deals', { title: 'Rep deal' }).expect(201);
    // Hidden fields cannot be used to filter (no probing their values).
    const filter = encodeURIComponent(JSON.stringify({ field: 'cf.margin', op: 'gt', value: 0.1 }));
    expect((await client.get(`/deals?filter=${filter}`)).status).toBe(403);
    // Bootstrap hides the field from this role entirely.
    const boot = await client.get('/meta/bootstrap').expect(200);
    expect(boot.body.customFields.some((f: { key: string }) => f.key === 'margin')).toBe(false);
    // Timeline diffs never leak hidden values.
    await admin.patch(`/deals/${deal.body.uuid}`, { custom: { margin: 0.5 } }).expect(200);
    const timeline = await client.get(`/deals/${deal.body.uuid}/timeline`).expect(200);
    expect(JSON.stringify(timeline.body)).not.toContain('custom.margin');
    // Shared test database: don't leave a required deal field behind for other files.
    await admin.post(`/custom-fields/${po.body.uuid}/archive`).expect(200);
  });

  it('archives a field without losing values and refuses to remove select options', async () => {
    const { client } = await clientWithRoles(['admin']);
    const f = await client
      .post('/custom-fields', { entity: 'contact', key: 'shoe_size', label: 'Shoe size', type: 'number' })
      .expect(201);
    const c = await client.post('/contacts', { firstName: 'Bo', custom: { shoe_size: 42 } }).expect(201);
    await client.post(`/custom-fields/${f.body.uuid}/archive`).expect(200);
    expect((await client.get(`/contacts/${c.body.uuid}`)).body.custom).toEqual({});
    expect((await db('contacts').where({ uuid: c.body.uuid }).first()).custom).toEqual({ shoe_size: 42 });
    await client.post(`/custom-fields/${f.body.uuid}/restore`).expect(200);
    expect((await client.get(`/contacts/${c.body.uuid}`)).body.custom).toEqual({ shoe_size: 42 });

    const s = await client
      .post('/custom-fields', {
        entity: 'contact',
        key: 'colour',
        label: 'Colour',
        type: 'select',
        options: [
          { key: 'red', label: 'Red' },
          { key: 'blue', label: 'Blue' },
        ],
      })
      .expect(201);
    await client
      .patch(`/custom-fields/${s.body.uuid}`, { options: [{ key: 'red', label: 'Red' }] })
      .expect(422);
    await client
      .patch(`/custom-fields/${s.body.uuid}`, {
        options: [
          { key: 'red', label: 'Red' },
          { key: 'blue', label: 'Blue', active: false },
        ],
      })
      .expect(200);
    await client.post('/contacts', { firstName: 'Old', custom: { colour: 'blue' } }).expect(422);
  });
});
