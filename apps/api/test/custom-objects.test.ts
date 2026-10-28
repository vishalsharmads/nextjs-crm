import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, unique, type Client } from './helpers';
import { db } from '../src/db/knex';

describe('custom objects', () => {
  let admin: Client;
  const key = `veh_${Date.now().toString(36)}`;
  const base = `/o/${key.replace(/_/g, '-')}`;
  let objectUuid: string;

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    const res = await admin
      .post('/objects', { key, singular: 'Vehicle', plural: 'Vehicles', icon: 'package', links: ['contact'] })
      .expect(201);
    objectUuid = res.body.uuid;
    expect(res.body).toMatchObject({
      key,
      route: key.replace(/_/g, '-'),
      links: ['contact'],
      archived: false,
    });
  });

  it('rejects reserved and duplicate keys, and removing links', async () => {
    await admin.post('/objects', { key: 'contact', singular: 'A', plural: 'As' }).expect(409);
    await admin.post('/objects', { key: 'pipeline', singular: 'A', plural: 'As' }).expect(409);
    await admin.post('/objects', { key, singular: 'A', plural: 'As' }).expect(409);
    await admin.post('/objects', { key: 'Bad Key', singular: 'A', plural: 'As' }).expect(422);
    await admin.patch(`/objects/${objectUuid}`, { links: [] }).expect(422);
  });

  it('only admins with fields.manage can manage objects', async () => {
    const rep = await loginAs(await createUser({ roleKeys: [await createRole(['core.contacts.view'])] }));
    await rep.get('/objects').expect(403);
    await rep.post('/objects', { key: unique('x').toLowerCase(), singular: 'A', plural: 'As' }).expect(403);
  });

  it('creates, reads, updates, searches, links, deletes and restores records', async () => {
    const contact = await admin
      .post('/contacts', { firstName: 'Lin', lastName: unique('Driver') })
      .expect(201);
    const name = unique('Van ');
    const created = await admin.post(base, { name, contactUuid: contact.body.uuid }).expect(201);
    expect(created.body).toMatchObject({ name, contact: { uuid: contact.body.uuid } });

    await admin.patch(`${base}/${created.body.uuid}`, { name: `${name} 2` }).expect(200);
    const got = await admin.get(`${base}/${created.body.uuid}`).expect(200);
    expect(got.body.name).toBe(`${name} 2`);

    const list = await admin.get(`${base}?q=${encodeURIComponent(name)}`).expect(200);
    expect(list.body.data.map((r: { uuid: string }) => r.uuid)).toContain(created.body.uuid);
    const search = await admin.get(`/search?q=${encodeURIComponent(name)}`).expect(200);
    expect(search.body.data.map((r: { uuid: string }) => r.uuid)).toContain(created.body.uuid);

    await admin.post(base, {}).expect(422);
    await admin.delete(`${base}/${created.body.uuid}`).expect(204);
    await admin.get(`${base}/${created.body.uuid}`).expect(404);
    await admin.post(`${base}/${created.body.uuid}/restore`).expect(200);

    const audit = await db('audit_logs').where({ entity_uuid: created.body.uuid });
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });

  it('supports custom fields, export and the bootstrap menu', async () => {
    const field = await admin
      .post('/custom-fields', { entity: key, key: 'plate', label: 'Plate', type: 'text' })
      .expect(201);
    const rec = await admin.post(base, { name: unique('Truck '), custom: { plate: 'AB12' } }).expect(201);
    expect(rec.body.custom).toEqual({ plate: 'AB12' });
    const csv = await admin.get(`${base}/export`).expect(200);
    expect(csv.text).toContain('AB12');
    const boot = await admin.get('/meta/bootstrap').expect(200);
    expect(boot.body.modules.menu).toContainEqual(expect.objectContaining({ key, path: base }));
    expect(boot.body.recordTypes).toContainEqual(
      expect.objectContaining({ entity: key, moduleKey: 'custom' }),
    );
    await admin.post(`/custom-fields/${field.body.uuid}/archive`).expect(200);
  });

  it('applies permissions and own scope', async () => {
    const theirs = await admin.post(base, { name: unique('Theirs ') }).expect(201);
    const role = await createRole([`custom.${key}.*`], { [`custom.${key}`]: 'own' });
    const rep = await loginAs(await createUser({ roleKeys: [role] }));
    const mine = await rep.post(base, { name: unique('Mine ') }).expect(201);
    const list = await rep.get(base).expect(200);
    const uuids = list.body.data.map((r: { uuid: string }) => r.uuid);
    expect(uuids).toContain(mine.body.uuid);
    expect(uuids).not.toContain(theirs.body.uuid);
    await rep.get(`${base}/${theirs.body.uuid}`).expect(404);
    await rep.patch(`${base}/${theirs.body.uuid}`, { name: 'x' }).expect(404);

    const none = await loginAs(await createUser({ roleKeys: [await createRole(['core.contacts.view'])] }));
    await none.get(base).expect(403);
    await none.post(base, { name: 'x' }).expect(403);
  });

  it('cannot link to a contact outside the user scope', async () => {
    const hidden = await admin.post('/contacts', { firstName: 'Hid', lastName: unique('Den') }).expect(201);
    const role = await createRole([`custom.${key}.*`, 'core.contacts.view'], {
      [`custom.${key}`]: 'own',
      'core.contacts': 'own',
    });
    const rep = await loginAs(await createUser({ roleKeys: [role] }));
    await rep.post(base, { name: 'x', contactUuid: hidden.body.uuid }).expect(422);
  });

  it('reaches data subject export and erasure through its contact link', async () => {
    const c = await admin.post('/contacts', { firstName: 'Era', lastName: unique('Sure') }).expect(201);
    const rec = await admin.post(base, { name: unique('Linked '), contactUuid: c.body.uuid }).expect(201);
    const res = await admin.post(`/privacy/contact/${c.body.uuid}/anonymize`).expect(200);
    expect(JSON.stringify(res.body.cleared)).toContain(key);
    const row = await db(`m_custom_${key}`).where({ uuid: rec.body.uuid }).first();
    expect(row.contact_id).toBeNull();
  });

  it('archiving hides the object and its records; restoring brings them back', async () => {
    const rec = await admin.post(base, { name: unique('Kept ') }).expect(201);
    await admin.post(`/objects/${objectUuid}/archive`).expect(200);
    await admin.get(base).expect(404);
    await admin.get(`${base}/${rec.body.uuid}`).expect(404);
    const boot = await admin.get('/meta/bootstrap').expect(200);
    expect(boot.body.recordTypes.map((t: { entity: string }) => t.entity)).not.toContain(key);
    await admin.post(`/objects/${objectUuid}/restore`).expect(200);
    await admin.get(`${base}/${rec.body.uuid}`).expect(200);
  });

  it('adds a link later', async () => {
    const org = await admin.post('/organizations', { name: unique('Fleet ') }).expect(201);
    const res = await admin
      .patch(`/objects/${objectUuid}`, { links: ['contact', 'organization'] })
      .expect(200);
    expect(res.body.links).toEqual(['contact', 'organization']);
    const rec = await admin.post(base, { name: unique('Car '), organizationUuid: org.body.uuid }).expect(201);
    expect(rec.body.organization).toMatchObject({ uuid: org.body.uuid });
  });
});
