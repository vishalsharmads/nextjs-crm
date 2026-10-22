import { beforeAll, describe, expect, it } from 'vitest';
import { anonymousClient, clientWithRoles, createRole, takeMail, type Client } from './helpers';
import { db } from '../src/db/knex';

const D = '/m/documents';

async function portalClient(admin: Client, contactUuid: string, email: string) {
  takeMail();
  await admin.post('/m/portal/accounts', { contactUuid }).expect(201);
  const [invite] = takeMail().filter((m) => m.to === email);
  const customer = await anonymousClient();
  await customer
    .post('/public/portal/session', { token: decodeURIComponent(/token=([^\s&"]+)/.exec(invite!.text)![1]!) })
    .expect(200);
  return customer;
}

describe('documents', () => {
  let admin: Client;
  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    for (const k of ['documents', 'portal']) await admin.post(`/modules/${k}/enable`).expect(200);
  });

  it('renders templates with escaped values and sanitized markup', async () => {
    const c = await admin
      .post('/contacts', {
        firstName: '<script>alert(1)</script>Dee',
        lastName: 'Docs',
        email: 'dee.docs@example.test',
      })
      .expect(201);
    expect((await admin.post(`${D}/templates`, { name: 'Broken', body: '{{#if}}' })).status).toBe(422);
    const t = await admin
      .post(`${D}/templates`, {
        name: 'Welcome letter',
        body: '<h1>Welcome {{contact.firstName}}</h1><p onclick="x()">Dated {{today}} from {{business.name}}</p><script>bad()</script>',
        requiresSignature: true,
      })
      .expect(201);
    const preview = await admin
      .post(`${D}/templates/${t.body.uuid}/preview`, { contactUuid: c.body.uuid })
      .expect(200);
    expect(preview.body.html).toContain('Welcome &lt;script&gt;');
    expect(preview.body.html).not.toContain('<script>');
    expect(preview.body.html).not.toContain('onclick');
    const doc = await admin
      .post(`${D}/documents`, { templateUuid: t.body.uuid, contactUuid: c.body.uuid })
      .expect(201);
    expect(doc.body).toMatchObject({ status: 'draft', title: 'Welcome letter', requiresSignature: true });
    expect(doc.body.number).toMatch(/^D-\d{5}$/);
    await admin
      .patch(`${D}/documents/${doc.body.uuid}`, { bodyHtml: '<p>Edited<img src=x onerror=y></p>' })
      .expect(200);
    const edited = await admin.get(`${D}/documents/${doc.body.uuid}`).expect(200);
    expect(edited.body.bodyHtml).toBe('<p>Edited</p>');
  });

  it('shares a document to the portal, where the customer signs it once', async () => {
    const c = await admin.post('/contacts', { firstName: 'Sam', email: 'sam.docs@example.test' }).expect(201);
    const t = await admin
      .post(`${D}/templates`, {
        name: 'Agreement',
        body: '<p>I, {{contact.fullName}}, agree.</p>',
        requiresSignature: true,
      })
      .expect(201);
    const doc = await admin
      .post(`${D}/documents`, { templateUuid: t.body.uuid, contactUuid: c.body.uuid })
      .expect(201);
    const customer = await portalClient(admin, c.body.uuid, 'sam.docs@example.test');

    // Drafts are invisible to the customer.
    expect((await customer.get(`/public/portal/docs/${doc.body.uuid}`)).status).toBe(404);
    await admin.post(`${D}/documents/${doc.body.uuid}/share`).expect(200);
    expect((await admin.patch(`${D}/documents/${doc.body.uuid}`, { title: 'x' })).status).toBe(409);

    const lib = await customer.get('/public/portal/library').expect(200);
    expect(lib.body.documents.map((d: { uuid: string }) => d.uuid)).toEqual([doc.body.uuid]);
    expect((await customer.post(`/public/portal/docs/${doc.body.uuid}/sign`, { name: 'Sam S' })).status).toBe(
      422,
    );
    const signed = await customer
      .post(`/public/portal/docs/${doc.body.uuid}/sign`, { name: 'Sam S', agree: true })
      .expect(200);
    expect(signed.body).toMatchObject({ status: 'signed', signedName: 'Sam S' });
    expect(
      (await customer.post(`/public/portal/docs/${doc.body.uuid}/sign`, { name: 'Sam S', agree: true }))
        .status,
    ).toBe(409);
    const row = await db('m_documents_documents').where({ uuid: doc.body.uuid }).first();
    expect(row.signed_hash).toHaveLength(64);
  });

  it('collects files through the portal and lets staff review them', async () => {
    const c = await admin.post('/contacts', { firstName: 'Fay', email: 'fay.docs@example.test' }).expect(201);
    const req = await admin
      .post(`${D}/requests`, {
        contactUuid: c.body.uuid,
        items: [{ name: 'Passport copy', dueDate: '2031-01-01' }, { name: 'Proof of address' }],
      })
      .expect(201);
    expect(req.body.data).toHaveLength(2);
    const [passport] = req.body.data;
    const customer = await portalClient(admin, c.body.uuid, 'fay.docs@example.test');

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    await customer.agent
      .post(`/api/v1/public/portal/requests/${passport.uuid}/upload`)
      .set('x-csrf-token', customer.csrf)
      .attach('file', pdf, 'passport.pdf')
      .expect(201);
    // A second upload to a submitted request is refused before the body is parsed.
    const again = await customer.agent
      .post(`/api/v1/public/portal/requests/${passport.uuid}/upload`)
      .set('x-csrf-token', customer.csrf)
      .attach('file', pdf, 'passport.pdf');
    expect(again.status).toBe(404);

    const open = await admin.get(`${D}/requests?contactUuid=${c.body.uuid}&status=open`).expect(200);
    const submitted = open.body.data.find((r: { uuid: string }) => r.uuid === passport.uuid);
    expect(submitted).toMatchObject({
      status: 'submitted',
      file: { name: 'passport.pdf', mime: 'application/pdf' },
    });
    // The file also appears on the contact record.
    const files = await admin.get(`/files?entity=contact&uuid=${c.body.uuid}`).expect(200);
    expect(files.body.data.map((f: { name: string }) => f.name)).toContain('passport.pdf');

    const rejected = await admin
      .post(`${D}/requests/${passport.uuid}/review`, { decision: 'rejected', note: 'Too blurry' })
      .expect(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', reviewNote: 'Too blurry' });
    const lib = await customer.get('/public/portal/library').expect(200);
    expect(lib.body.requests.find((r: { uuid: string }) => r.uuid === passport.uuid).reviewNote).toBe(
      'Too blurry',
    );
    // Rejected requests accept a new upload.
    await customer.agent
      .post(`/api/v1/public/portal/requests/${passport.uuid}/upload`)
      .set('x-csrf-token', customer.csrf)
      .attach('file', pdf, 'passport-2.pdf')
      .expect(201);
    await admin.post(`${D}/requests/${passport.uuid}/review`, { decision: 'approved' }).expect(200);
  });

  it('keeps documents and requests inside contact scope', async () => {
    const hidden = await admin
      .post('/contacts', { firstName: 'Hidden', email: 'hidden.docs@example.test' })
      .expect(201);
    const t = await admin.post(`${D}/templates`, { name: 'Note', body: '<p>Hi</p>' }).expect(201);
    const doc = await admin
      .post(`${D}/documents`, { templateUuid: t.body.uuid, contactUuid: hidden.body.uuid })
      .expect(201);
    const req = await admin
      .post(`${D}/requests`, { contactUuid: hidden.body.uuid, items: [{ name: 'ID' }] })
      .expect(201);
    const role = await createRole(['documents.documents.*', 'core.contacts.view'], { '*': 'own' });
    const { client } = await clientWithRoles([role]);
    expect((await client.get(`${D}/documents/${doc.body.uuid}`)).status).toBe(404);
    expect(
      (await client.post(`${D}/documents`, { templateUuid: t.body.uuid, contactUuid: hidden.body.uuid }))
        .status,
    ).toBe(404);
    expect(
      (await client.get(`${D}/documents`)).body.data.some((d: { uuid: string }) => d.uuid === doc.body.uuid),
    ).toBe(false);
    expect((await client.post(`${D}/requests/${req.body.data[0].uuid}/cancel`)).status).toBe(404);
    // Staff uploads are refused before the body is parsed when out of scope.
    const up = await client.agent
      .post(`/api/v1${D}/requests/${req.body.data[0].uuid}/file`)
      .set('x-csrf-token', client.csrf)
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF'), 'x.pdf');
    expect(up.status).toBe(404);
  });
});
