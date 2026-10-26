import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/knex';
import { clientWithRoles, createUser, loginAs, type Client } from './helpers';

let admin: Client;
beforeAll(async () => {
  admin = (await clientWithRoles(['admin'])).client;
});

describe('transfer records', () => {
  it('moves owned and assigned records to another active user and audits it', async () => {
    const leaver = await createUser({ roleKeys: ['sales_rep'] });
    const heir = await createUser({ roleKeys: ['sales_rep'] });
    const contact = await admin
      .post('/contacts', { firstName: 'Handover', ownerUuid: leaver.uuid })
      .expect(201);
    const org = await admin
      .post('/organizations', { name: 'Handover Ltd', ownerUuid: leaver.uuid })
      .expect(201);

    const res = await admin.post(`/users/${leaver.uuid}/transfer-records`, { toUuid: heir.uuid }).expect(200);
    expect(res.body.moved.contact).toBeGreaterThanOrEqual(1);
    expect(res.body.moved.organization).toBeGreaterThanOrEqual(1);

    const row = await db('contacts').where({ uuid: contact.body.uuid }).first();
    expect(row.owner_id).toBe(heir.id);
    const orgRow = await db('organizations').where({ uuid: org.body.uuid }).first();
    expect(orgRow.owner_id).toBe(heir.id);
    expect(await db('contacts').where({ owner_id: leaver.id }).count({ n: '*' }).first()).toMatchObject({
      n: 0,
    });
    const log = await db('audit_logs')
      .where({ action: 'user.records_transferred', entity_uuid: leaver.uuid })
      .first();
    expect(log).toBeTruthy();
  });

  it('refuses the same user, an inactive target and callers without the permission', async () => {
    const a = await createUser({ roleKeys: ['sales_rep'] });
    const invited = await createUser({ roleKeys: ['sales_rep'] });
    await db('users').where({ id: invited.id }).update({ status: 'invited' });
    await admin.post(`/users/${a.uuid}/transfer-records`, { toUuid: a.uuid }).expect(422);
    await admin.post(`/users/${a.uuid}/transfer-records`, { toUuid: invited.uuid }).expect(422);
    const rep = await loginAs(await createUser({ roleKeys: ['sales_rep'] }));
    await rep.post(`/users/${a.uuid}/transfer-records`, { toUuid: invited.uuid }).expect(403);
  });
});
