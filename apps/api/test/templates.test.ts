import { describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, unique } from './helpers';

interface Group {
  key: string;
  fields: { path: string; label: string }[];
}

async function savedReply(body: string, subject = 'Hello {{contact.firstName}}') {
  const { client } = await clientWithRoles(['admin']);
  const t = await client
    .post('/templates', { key: `reply.${unique('r')}`, channel: 'email', name: 'Follow-up', subject, body })
    .expect(201);
  return { admin: client, uuid: t.body.uuid as string };
}

describe('saved replies', () => {
  it('renders for a record with escaped values and a sanitized body', async () => {
    const { admin, uuid } = await savedReply(
      '<p>Hi {{contact.firstName}}, from {{user.firstName}}.</p><script>alert(1)</script><img src=x onerror=alert(1)>',
    );
    const c = await admin.post('/contacts', { firstName: 'Ann <b>', lastName: 'Reply' }).expect(201);
    const listed = await admin.get('/templates/replies').expect(200);
    expect(listed.body.data.some((r: { uuid: string }) => r.uuid === uuid)).toBe(true);
    const out = await admin
      .post(`/templates/replies/${uuid}/render`, { related: { type: 'contact', uuid: c.body.uuid } })
      .expect(200);
    expect(out.body.subject).toBe('Hello Ann &lt;b&gt;');
    expect(out.body.html).toContain('Hi Ann &lt;b&gt;, from');
    expect(out.body.html).not.toMatch(/script|onerror|<img/);
  });

  it('renders without a record, leaving record placeholders empty', async () => {
    const { admin, uuid } = await savedReply('<p>Hi {{contact.firstName}}!</p>');
    const out = await admin.post(`/templates/replies/${uuid}/render`, {}).expect(200);
    expect(out.body.html).toBe('<p>Hi !</p>');
  });

  it("returns 404 for a record outside the user's scope", async () => {
    const { admin, uuid } = await savedReply('<p>{{contact.email}}</p>');
    const c = await admin
      .post('/contacts', { firstName: 'Hidden', email: 'hidden@example.test' })
      .expect(201);
    const role = await createRole(['core.contacts.view'], { '*': 'own' });
    const { client } = await clientWithRoles([role]);
    await client
      .post(`/templates/replies/${uuid}/render`, { related: { type: 'contact', uuid: c.body.uuid } })
      .expect(404);
  });

  it('refuses a record type the user cannot view', async () => {
    const { admin, uuid } = await savedReply('<p>{{deal.title}}</p>');
    const deal = await admin.post('/deals', { title: 'Scoped deal' }).expect(201);
    const role = await createRole(['core.contacts.view']);
    const { client } = await clientWithRoles([role]);
    await client
      .post(`/templates/replies/${uuid}/render`, { related: { type: 'deal', uuid: deal.body.uuid } })
      .expect(403);
  });

  it('does not list or render system emails', async () => {
    const { client } = await clientWithRoles(['admin']);
    const t = await client
      .post('/templates', {
        key: `system.${unique('s')}`,
        channel: 'email',
        name: 'System',
        subject: 'x',
        body: '<p>{{link}}</p>',
      })
      .expect(201);
    const listed = await client.get('/templates/replies').expect(200);
    expect(listed.body.data.some((r: { uuid: string }) => r.uuid === t.body.uuid)).toBe(false);
    await client.post(`/templates/replies/${t.body.uuid}/render`, {}).expect(404);
  });
});

describe('template merge fields', () => {
  it("lists core and custom fields, leaving out hidden and special ones for the user's role", async () => {
    const role = await createRole(['core.templates.manage', 'core.contacts.view']);
    const { client: admin } = await clientWithRoles(['admin']);
    const open = unique('mf_open_').replace(/[^a-z0-9_]/g, '_');
    const secret = unique('mf_secret_').replace(/[^a-z0-9_]/g, '_');
    const special = unique('mf_special_').replace(/[^a-z0-9_]/g, '_');
    await admin
      .post('/custom-fields', { entity: 'contact', key: open, label: 'Open field', type: 'text' })
      .expect(201);
    await admin
      .post('/custom-fields', {
        entity: 'contact',
        key: secret,
        label: 'Secret field',
        type: 'text',
        visibility: { default: 'write', roles: { [role]: 'hidden' } },
      })
      .expect(201);
    await admin
      .post('/custom-fields', {
        entity: 'contact',
        key: special,
        label: 'Special field',
        type: 'text',
        sensitivity: 'special',
      })
      .expect(201);

    const { client } = await clientWithRoles([role]);
    const groups = (await client.get('/templates/fields').expect(200)).body.data as Group[];
    const paths = groups.flatMap((g) => g.fields.map((f) => f.path));
    expect(paths).toContain('contact.firstName');
    expect(paths).toContain(`contact.custom.${open}`);
    expect(paths).not.toContain(`contact.custom.${secret}`);
    expect(paths).not.toContain(`contact.custom.${special}`);
    // No permission to view deals, so their fields are not offered.
    expect(groups.some((g) => g.key === 'deal')).toBe(false);

    const all = (await admin.get('/templates/fields').expect(200)).body.data as Group[];
    expect(all.flatMap((g) => g.fields.map((f) => f.path))).toContain(`contact.custom.${secret}`);
  });

  it('needs permission to manage templates', async () => {
    const role = await createRole(['core.contacts.view']);
    const { client } = await clientWithRoles([role]);
    await client.get('/templates/fields').expect(403);
  });
});
