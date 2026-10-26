import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, loginAs, createUser, type Client } from './helpers';

const notes = (body: { data: { kind: string; activity?: { body: string | null } }[] }) =>
  body.data.filter((i) => i.kind === 'activity').map((i) => i.activity?.body);

describe('timeline roll-up', () => {
  let admin: Client;
  let org: string;
  let contact: string;
  let adminDeal: string;
  let repDeal: string;
  let repRole: string;

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    repRole = await createRole(['core.contacts.view', 'core.organizations.view', 'core.deals.view'], {
      'core.contacts': 'all',
      'core.organizations': 'all',
      'core.deals': 'own',
    });
    org = (await admin.post('/organizations', { name: 'Rollup Ltd' }).expect(201)).body.uuid;
    contact = (
      await admin.post('/contacts', { firstName: 'Rolly', lastName: 'Up', organizationUuid: org }).expect(201)
    ).body.uuid;
    adminDeal = (
      await admin
        .post('/deals', { title: 'Admin deal', contactUuid: contact, organizationUuid: org })
        .expect(201)
    ).body.uuid;
    await admin
      .post('/activities', {
        type: 'note',
        body: '<p>On the contact</p>',
        related: { type: 'contact', uuid: contact },
      })
      .expect(201);
    await admin
      .post('/activities', {
        type: 'note',
        body: '<p>On the admin deal</p>',
        related: { type: 'deal', uuid: adminDeal },
      })
      .expect(201);
  });

  it("shows a deal's notes on its contact and organization, and says where they were logged", async () => {
    const c = await admin.get(`/contacts/${contact}/timeline`).expect(200);
    expect(notes(c.body)).toEqual(
      expect.arrayContaining(['<p>On the contact</p>', '<p>On the admin deal</p>']),
    );
    const rolled = c.body.data.find(
      (i: { activity?: { body: string } }) => i.activity?.body === '<p>On the admin deal</p>',
    );
    expect(rolled.activity.related).toMatchObject({ type: 'deal', uuid: adminDeal, title: 'Admin deal' });

    const o = await admin.get(`/organizations/${org}/timeline`).expect(200);
    expect(notes(o.body)).toEqual(
      expect.arrayContaining(['<p>On the contact</p>', '<p>On the admin deal</p>']),
    );
  });

  it("never shows notes from deals outside the viewer's scope", async () => {
    const rep = await createUser({ roleKeys: [repRole] });
    repDeal = (
      await admin.post('/deals', { title: 'Rep deal', contactUuid: contact, ownerUuid: rep.uuid }).expect(201)
    ).body.uuid;
    await admin
      .post('/activities', {
        type: 'note',
        body: '<p>On the rep deal</p>',
        related: { type: 'deal', uuid: repDeal },
      })
      .expect(201);
    const client = await loginAs(rep);
    const seen = notes((await client.get(`/contacts/${contact}/timeline`).expect(200)).body);
    expect(seen).toContain('<p>On the contact</p>');
    expect(seen).toContain('<p>On the rep deal</p>');
    expect(seen).not.toContain('<p>On the admin deal</p>');
    const viaOrg = notes((await client.get(`/organizations/${org}/timeline`).expect(200)).body);
    expect(viaOrg).not.toContain('<p>On the admin deal</p>');
  });

  it('shows no deal notes to someone who cannot view deals', async () => {
    const role = await createRole(['core.contacts.view'], { 'core.contacts': 'all' });
    const { client } = await clientWithRoles([role]);
    const seen = notes((await client.get(`/contacts/${contact}/timeline`).expect(200)).body);
    expect(seen).toEqual(['<p>On the contact</p>']);
  });

  it("never shows notes from contacts outside the viewer's scope on an organization", async () => {
    const role = await createRole(['core.contacts.view', 'core.organizations.view'], {
      'core.contacts': 'own',
      'core.organizations': 'all',
    });
    const viewer = await createUser({ roleKeys: [role] });
    const mine = (
      await admin
        .post('/contacts', {
          firstName: 'Own',
          lastName: 'Contact',
          organizationUuid: org,
          ownerUuid: viewer.uuid,
        })
        .expect(201)
    ).body.uuid;
    await admin
      .post('/activities', {
        type: 'note',
        body: '<p>On my contact</p>',
        related: { type: 'contact', uuid: mine },
      })
      .expect(201);
    const client = await loginAs(viewer);
    const seen = notes((await client.get(`/organizations/${org}/timeline`).expect(200)).body);
    expect(seen).toContain('<p>On my contact</p>');
    expect(seen).not.toContain('<p>On the contact</p>');
    expect(seen).not.toContain('<p>On the admin deal</p>');
  });
});
