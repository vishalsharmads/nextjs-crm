import { describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs } from './helpers';
import { db } from '../src/db/knex';

describe('record sharing', () => {
  it('opens one record to one person, view or edit, never delete', async () => {
    // Full deal permissions but own scope: only sharing can open someone else's deal.
    const role = await createRole(['core.deals.*', 'core.activities.*'], { '*': 'own' });
    const owner = await createUser({ roleKeys: [role] });
    const guest = await createUser({ roleKeys: [role] });
    const ownerClient = await loginAs(owner);
    const guestClient = await loginAs(guest);
    const deal = await ownerClient.post('/deals', { title: `Shared ${Date.now()}` }).expect(201);
    const other = await ownerClient.post('/deals', { title: `Not shared ${Date.now()}` }).expect(201);
    const url = `/deals/${deal.body.uuid}`;

    // Own scope: the guest sees neither.
    await guestClient.get(url).expect(404);

    const share = await ownerClient
      .post(`${url}/shares`, { userUuid: guest.uuid, level: 'view' })
      .expect(201);
    expect(share.body.level).toBe('view');
    const notes = await db('notifications').where({ user_id: guest.id, type: 'record.shared' });
    expect(notes).toHaveLength(1);

    // View share: read, list, search, comment; no edits, no delete, no sharing onwards.
    await guestClient.get(url).expect(200);
    const list = await guestClient.get('/deals?pageSize=100').expect(200);
    const listed = list.body.data.map((d: { uuid: string }) => d.uuid);
    expect(listed).toContain(deal.body.uuid);
    expect(listed).not.toContain(other.body.uuid);
    await guestClient.post(`${url}/comments`, { body: 'Looks good' }).expect(201);
    await guestClient.patch(url, { title: 'Changed' }).expect(404);
    const third = await createUser({ roleKeys: ['sales_rep'] });
    await guestClient.post(`${url}/shares`, { userUuid: third.uuid }).expect(403);

    // Edit share: changes allowed, delete still not.
    await ownerClient.post(`${url}/shares`, { userUuid: guest.uuid, level: 'edit' }).expect(201);
    await guestClient.patch(url, { title: 'Changed by guest' }).expect(200);
    await guestClient.delete(url).expect(404);
    await guestClient
      .post('/deals/bulk', { action: 'delete', uuids: [deal.body.uuid] })
      .expect(200)
      .expect((r) => expect(r.body.affected).toBe(0));

    // The guest may remove their own access; then the record is gone for them.
    const shares = await ownerClient.get(`${url}/shares`).expect(200);
    expect(shares.body.canManage).toBe(true);
    expect(shares.body.data).toHaveLength(1);
    await guestClient.delete(`${url}/shares/${shares.body.data[0].uuid}`).expect(204);
    await guestClient.get(url).expect(404);
  });

  it('shares with a team and never grants a permission the role lacks', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const member = await createUser({ roleKeys: ['sales_rep'] });
    const team = await admin
      .post('/teams', { name: `Share team ${Date.now()}`, memberUuids: [member.uuid] })
      .expect(201);
    const org = await admin.post('/organizations', { name: `Team shared ${Date.now()}` }).expect(201);
    await admin.post(`/organizations/${org.body.uuid}/shares`, { teamUuid: team.body.uuid }).expect(201);
    await (await loginAs(member)).get(`/organizations/${org.body.uuid}`).expect(200);

    // A role without organizations.view sees nothing, shared or not.
    const role = await createRole(['core.contacts.view'], { '*': 'own' });
    const { client: noView, user: noViewUser } = await clientWithRoles([role]);
    await admin.post(`/organizations/${org.body.uuid}/shares`, { userUuid: noViewUser.uuid }).expect(201);
    await noView.get(`/organizations/${org.body.uuid}`).expect(403);
  });

  it('does not carry shares into the kept record when records merge', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const guest = await createUser({ roleKeys: ['sales_rep'] });
    const a = await admin.post('/contacts', { firstName: 'Keep', lastName: `Me${Date.now()}` }).expect(201);
    const b = await admin.post('/contacts', { firstName: 'Merge', lastName: `Me${Date.now()}` }).expect(201);
    await admin.post(`/contacts/${b.body.uuid}/shares`, { userUuid: guest.uuid }).expect(201);
    await admin
      .post('/contacts/merge', { primaryUuid: a.body.uuid, secondaryUuids: [b.body.uuid] })
      .expect(200);
    await (await loginAs(guest)).get(`/contacts/${a.body.uuid}`).expect(404);
  });

  it('an edit share cannot take ownership, and a view share cannot add files', async () => {
    const role = await createRole(['core.contacts.*', 'core.files.*'], { '*': 'own' });
    const owner = await createUser({ roleKeys: [role] });
    const guest = await createUser({ roleKeys: [role] });
    const ownerClient = await loginAs(owner);
    const guestClient = await loginAs(guest);
    const c = await ownerClient
      .post('/contacts', { firstName: 'Taken', lastName: `Not${Date.now()}` })
      .expect(201);
    const url = `/contacts/${c.body.uuid}`;
    await ownerClient.post(`${url}/shares`, { userUuid: guest.uuid, level: 'view' }).expect(201);
    await guestClient.agent
      .post('/api/v1/files')
      .set('x-csrf-token', guestClient.csrf)
      .field('entity', 'contact')
      .field('uuid', c.body.uuid)
      .attach('file', Buffer.from('hello'), 'note.txt')
      .expect(404);
    await ownerClient.post(`${url}/shares`, { userUuid: guest.uuid, level: 'edit' }).expect(201);
    await guestClient.patch(url, { ownerUuid: guest.uuid }).expect(403);
    await guestClient.patch(url, { jobTitle: 'Editor' }).expect(200);
  });
});
