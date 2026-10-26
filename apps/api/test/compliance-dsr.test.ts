import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  anonymousClient,
  clientWithRoles,
  createRole,
  createUser,
  getApp,
  loginAs,
  restoreSettingsAfterEach,
  setSettingsGroup,
  takeMail,
  type Client,
} from './helpers';
import { db } from '../src/db/knex';
import { unsubscribeToken } from '../src/core/privacy/unsubscribe';
import { newUuid } from '../src/lib/ids';

restoreSettingsAfterEach(['compliance']);

const PURPOSES = [
  {
    key: 'newsletter',
    label: 'Newsletter',
    text: 'Send me the monthly newsletter.',
    lawfulBasis: 'consent',
    marketing: true,
  },
  {
    key: 'terms',
    label: 'Terms',
    text: 'I agree to the processing of this enquiry.',
    lawfulBasis: 'consent',
    marketing: false,
  },
];
const withPurposes = (extra: object = {}) =>
  setSettingsGroup('compliance', { consentPurposes: PURPOSES, ...extra });

let admin: Client;
beforeAll(async () => {
  ({ client: admin } = await clientWithRoles(['admin']));
  for (const k of ['tickets', 'portal', 'documents']) await admin.post(`/modules/${k}/enable`).expect(200);
});

describe('privacy requests', () => {
  it('tracks requests with a due date from the compliance settings', async () => {
    await setSettingsGroup('compliance', { dsarDueDays: 20 });
    const c = await admin.post('/contacts', { firstName: 'Asker' }).expect(201);
    const created = await admin
      .post('/privacy/requests', {
        type: 'access',
        subjectEntity: 'contact',
        subjectUuid: c.body.uuid,
        receivedAt: '2026-01-01',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'open',
      dueAt: '2026-01-21',
      overdue: true,
      subject: { entity: 'contact', uuid: c.body.uuid, name: 'Asker' },
    });
    const overdue = await admin.get('/privacy/requests?overdue=true').expect(200);
    expect(overdue.body.data.map((r: { uuid: string }) => r.uuid)).toContain(created.body.uuid);

    const done = await admin
      .patch(`/privacy/requests/${created.body.uuid}`, { status: 'completed', resolution: 'Export sent' })
      .expect(200);
    expect(done.body.completedAt).not.toBeNull();
    expect(done.body.overdue).toBe(false);
    expect(
      await db('audit_logs')
        .where({ action: 'privacy_request.updated', entity_uuid: created.body.uuid })
        .first(),
    ).toBeTruthy();

    const role = await createRole(['core.contacts.view'], { 'core.contacts': 'all' });
    const { client } = await clientWithRoles([role]);
    await client.get('/privacy/requests').expect(403);
  });

  it('needs a linked record or a requester', async () => {
    expect((await admin.post('/privacy/requests', { type: 'erasure' })).status).toBe(422);
    await admin
      .post('/privacy/requests', { type: 'erasure', requesterEmail: 'someone@example.test' })
      .expect(201);
  });
});

describe('consent', () => {
  it('records decisions with the wording and keeps the marketing opt-out in step', async () => {
    await withPurposes();
    const c = await admin
      .post('/contacts', { firstName: 'Consenting', email: 'yes@example.test' })
      .expect(201);
    const granted = await admin
      .post(`/privacy/contact/${c.body.uuid}/consents`, {
        purposeKey: 'newsletter',
        status: 'granted',
        note: 'Phone call',
      })
      .expect(200);
    expect(granted.body.current).toContainEqual({
      purposeKey: 'newsletter',
      purposeLabel: 'Newsletter',
      status: 'granted',
    });
    expect(granted.body.marketingOptOut).toBe(false);
    expect(granted.body.history[0]).toMatchObject({
      source: 'manual',
      textSnapshot: 'Send me the monthly newsletter.',
    });

    const withdrawn = await admin
      .post(`/privacy/contact/${c.body.uuid}/consents`, { purposeKey: 'newsletter', status: 'withdrawn' })
      .expect(200);
    expect(withdrawn.body.marketingOptOut).toBe(true);
    expect((await admin.get(`/contacts/${c.body.uuid}`)).body.marketingOptOut).toBe(true);
    await expect(
      db('consents').where({ purpose_key: 'newsletter' }).update({ status: 'granted' }),
    ).rejects.toThrow(/append-only/);
    expect(
      (
        await admin.post(`/privacy/contact/${c.body.uuid}/consents`, {
          purposeKey: 'nope',
          status: 'granted',
        })
      ).status,
    ).toBe(422);
  });

  it('web forms show unticked purposes, require the required ones and record what was ticked', async () => {
    await withPurposes();
    const form = await admin
      .post('/forms', {
        name: 'Enquiry',
        entity: 'contact',
        fields: [
          { target: 'firstName', label: 'First name', required: true },
          { target: 'email', label: 'Email', required: true },
        ],
        settings: { consentPurposes: [{ key: 'newsletter' }, { key: 'terms', required: true }] },
      })
      .expect(201);
    const app = await getApp();
    const pub = await request(app).get(`/api/v1/public/forms/${form.body.uuid}`).expect(200);
    expect(pub.body.consents).toEqual([
      { key: 'newsletter', text: 'Send me the monthly newsletter.', required: false },
      { key: 'terms', text: 'I agree to the processing of this enquiry.', required: true },
    ]);
    const url = `/api/v1/public/forms/${form.body.uuid}/submit`;
    const missing = await request(app).post(url).send({ firstName: 'Form', email: 'form@example.test' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].path).toBe('consents.terms');
    await request(app)
      .post(url)
      .send({ firstName: 'Form', email: 'form@example.test', consents: { terms: true, newsletter: 'yes' } })
      .expect(200);
    const c = await db('contacts').where({ email: 'form@example.test' }).first('id');
    const rows = await db('consents').where({ subject_type: 'contact', subject_id: c.id });
    // Only a real `true` counts as a tick.
    expect(rows.map((r) => [r.purpose_key, r.status, r.source])).toEqual([['terms', 'granted', 'form']]);
    expect(rows[0].text_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (await admin.post('/forms', { ...form.body, settings: { consentPurposes: [{ key: 'ghost' }] } }))
        .status,
    ).toBe(422);
  });
});

describe('unsubscribe and opt-out of sale', () => {
  it('works from the signed link without a session, and refuses forged links', async () => {
    await withPurposes();
    const c = await admin.post('/contacts', { firstName: 'Leaving' }).expect(201);
    await admin
      .post(`/privacy/contact/${c.body.uuid}/consents`, { purposeKey: 'newsletter', status: 'granted' })
      .expect(200);
    const token = unsubscribeToken('contact', c.body.uuid);
    const app = await getApp();
    expect((await request(app).get('/api/v1/public/privacy/unsubscribe').query({ token })).body).toEqual({
      valid: true,
      optedOut: false,
    });
    // No session, no CSRF token: as a mail client's one-click POST.
    await request(app)
      .post('/api/v1/public/privacy/unsubscribe')
      .query({ token })
      .send({ doNotSell: true })
      .expect(200);
    const row = await db('contacts').where({ uuid: c.body.uuid }).first();
    expect(row.marketing_opt_out).toBeTruthy();
    expect(
      await db('consents').where({ subject_id: row.id, status: 'withdrawn', source: 'unsubscribe' }).first(),
    ).toBeTruthy();
    expect(
      await db('privacy_requests')
        .where({ subject_id: row.id, type: 'opt_out_sale_share', status: 'completed' })
        .first(),
    ).toBeTruthy();
    const forged = `c.${c.body.uuid}.${'0'.repeat(32)}`;
    expect(
      (await request(app).post('/api/v1/public/privacy/unsubscribe').send({ token: forged })).status,
    ).toBe(404);
  });

  it('automation email honours the opt-out and carries an unsubscribe link', async () => {
    await admin
      .post('/automations', {
        name: 'Welcome mail',
        triggerEvent: 'contact.created',
        actions: [
          { type: 'send_email', to: 'record', subject: 'Welcome', body: '<p>Hello {{record.firstName}}</p>' },
        ],
      })
      .expect(201);
    takeMail();
    await admin.post('/contacts', { firstName: 'Welcomed', email: 'welcomed@example.test' }).expect(201);
    const [mail] = takeMail().filter((m) => m.to === 'welcomed@example.test');
    expect(mail!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail!.html).toContain('/unsubscribe?token=');
    const auto = await db('automations').where({ name: 'Welcome mail' }).first();
    await db('automations').where({ id: auto.id }).update({ active: false });
  });
});

describe('restriction of processing', () => {
  it('stops webhooks, automations and outgoing email for the record', async () => {
    const hook = await admin
      .post('/webhooks', {
        name: 'Restricted check',
        url: 'http://127.0.0.1:9/hook',
        events: ['contact.updated'],
      })
      .expect(201);
    const c = await admin
      .post('/contacts', { firstName: 'Restricted', email: 'restricted@example.test' })
      .expect(201);
    await admin.post(`/privacy/contact/${c.body.uuid}/restriction`, { restricted: true }).expect(204);
    expect((await admin.get(`/contacts/${c.body.uuid}`)).body.processingRestricted).toBe(true);
    await admin.patch(`/contacts/${c.body.uuid}`, { jobTitle: 'Still stored' }).expect(200);
    const deliveries = await db('webhook_deliveries').whereRaw(
      "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.data.uuid')) = ?",
      [c.body.uuid],
    );
    expect(deliveries).toHaveLength(0);
    const sent = await admin.post('/email/send', {
      to: ['restricted@example.test'],
      subject: 'Hi',
      body: '<p>Hi</p>',
      related: { type: 'contact', uuid: c.body.uuid },
    });
    expect(sent.status).toBe(403);
    await admin.delete(`/webhooks/${hook.body.uuid}`).expect(204);
  });
});

describe('erasure', () => {
  async function personWithTraces() {
    await withPurposes();
    const c = await admin
      .post('/contacts', { firstName: 'Erasable', email: `erase-${newUuid()}@example.test` })
      .expect(201);
    const uuid = c.body.uuid as string;
    const id = (await db('contacts').where({ uuid }).first('id')).id as number;
    await admin
      .post(`/privacy/contact/${uuid}/consents`, { purposeKey: 'newsletter', status: 'granted' })
      .expect(200);
    await admin
      .post('/email/send', {
        to: [c.body.email],
        subject: 'Your diagnosis',
        body: '<p>Private</p>',
        related: { type: 'contact', uuid },
      })
      .expect(201);
    await db('webhook_deliveries').insert({
      uuid: newUuid(),
      webhook_id: (await db('webhooks').first('id'))?.id ?? (await createHook()),
      event: 'contact.updated',
      payload: JSON.stringify({ data: { uuid, record: { email: c.body.email } } }),
      next_attempt_at: new Date(),
    });
    await admin.agent
      .post('/api/v1/files')
      .set('x-csrf-token', admin.csrf)
      .field('entity', 'contact')
      .field('uuid', uuid)
      .attach('file', Buffer.from('scan'), 'scan.txt')
      .expect(201);
    await admin
      .post('/m/tickets/tickets', {
        subject: 'Help',
        description: 'My card number is 1234',
        contactUuid: uuid,
      })
      .expect(201);
    await admin.post('/m/portal/accounts', { contactUuid: uuid }).expect(201);
    return { uuid, id, email: c.body.email as string };
  }

  async function createHook() {
    const h = await admin.post('/webhooks', {
      name: 'Payload holder',
      url: 'http://127.0.0.1:9/x',
      events: ['deal.won'],
    });
    return (await db('webhooks').where({ uuid: h.body.uuid }).first('id')).id as number;
  }

  it('exports everything held about the person as a ZIP', async () => {
    const p = await personWithTraces();
    const res = await admin.agent
      .get(`/api/v1/privacy/contact/${p.uuid}/export`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = res.body as Buffer;
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(zip.includes(Buffer.from('personal-data.json'))).toBe(true);
    expect(zip.includes(Buffer.from('files/scan.txt'))).toBe(true);
    expect(
      await db('audit_logs').where({ action: 'contact.data_exported', entity_id: p.id }).first(),
    ).toBeTruthy();
  });

  it('anonymizes the person everywhere and reports what it cleared', async () => {
    const p = await personWithTraces();
    const res = await admin.post(`/privacy/contact/${p.uuid}/anonymize`).expect(200);
    expect(res.body.mode).toBe('anonymize');
    expect(res.body.cleared).toMatchObject({ files: 1, 'portal.accounts': 1, 'tickets.tickets': 1 });
    expect(res.body.cleared.emailMessages).toBeGreaterThan(0);
    expect(res.body.cleared.webhookDeliveries).toBeGreaterThan(0);

    expect((await db('contacts').where({ id: p.id }).first()).email).toBeNull();
    const msgs = await db('email_messages as m')
      .join('activities as a', 'a.id', 'm.activity_id')
      .where({ 'a.related_id': p.id, 'a.related_type': 'contact' });
    expect(JSON.stringify(msgs)).not.toContain(p.email);
    expect(JSON.stringify(msgs)).not.toContain('Your diagnosis');
    const payloads = await db('webhook_deliveries').where('payload', 'like', `%${p.email}%`);
    expect(payloads).toHaveLength(0);
    expect(await db('m_tickets_tickets').where({ contact_id: p.id }).first('description')).toEqual({
      description: null,
    });
    expect(await db('m_portal_accounts').where({ contact_id: p.id }).first()).toBeUndefined();
    const consent = await db('consents').where({ subject_type: 'contact', subject_id: p.id }).first();
    expect(consent.ip).toBeNull();
    expect(consent.text_snapshot).toBe('Send me the monthly newsletter.');
  });

  it('refuses a hard delete that would destroy signed documents', async () => {
    const p = await personWithTraces();
    await db('m_documents_documents').insert({
      uuid: newUuid(),
      number: `D-${Date.now()}`,
      title: 'Agreement',
      body_html: '<p>Agreed</p>',
      contact_id: p.id,
      status: 'signed',
      signed_name: 'Erasable',
    });
    const preview = await admin.delete(`/privacy/contact/${p.uuid}`);
    const code = preview.body.error.details[0].message;
    const res = await admin.delete(`/privacy/contact/${p.uuid}?confirm=${code}`);
    expect(res.status).toBe(409);
    expect(await db('contacts').where({ id: p.id }).first()).toBeTruthy();
  });

  it('hard-deletes with the confirmation code and keeps the request record', async () => {
    const p = await personWithTraces();
    const req = await admin
      .post('/privacy/requests', { type: 'erasure', subjectEntity: 'contact', subjectUuid: p.uuid })
      .expect(201);
    const preview = await admin.delete(`/privacy/contact/${p.uuid}`);
    const code = preview.body.error.details[0].message;
    const res = await admin.delete(`/privacy/contact/${p.uuid}?confirm=${code}`).expect(200);
    expect(res.body.mode).toBe('delete');
    expect(await db('contacts').where({ id: p.id }).first()).toBeUndefined();
    expect(await db('consents').where({ subject_type: 'contact', subject_id: p.id }).first()).toBeUndefined();
    const kept = await admin.get(`/privacy/requests/${req.body.uuid}`).expect(200);
    expect(kept.body.subject).toBeNull();
  });
});

describe('staff erasure', () => {
  it('erases a disabled user but keeps their audit trail attributable', async () => {
    const leaver = await createUser({ roleKeys: ['read_only'] });
    const c = await loginAs(leaver);
    await c.patch('/me', { firstName: 'Leaver' }).expect(200);
    await admin.post(`/users/${leaver.uuid}/anonymize`).expect(409);
    await admin.post(`/users/${leaver.uuid}/disable`).expect(200);
    await admin.post(`/users/${leaver.uuid}/anonymize`).expect(204);
    const row = await db('users').where({ id: leaver.id }).first();
    expect(row.email).toBe(`removed-${leaver.uuid}@invalid`);
    expect(row.password_hash).toBeNull();
    expect(await db('sessions').where({ user_id: leaver.id }).first()).toBeUndefined();
    expect(
      await db('audit_logs').where({ actor_id: leaver.id, action: 'user.profile_updated' }).first(),
    ).toBeTruthy();
    const anon = await anonymousClient();
    expect((await anon.post('/auth/login', { email: leaver.email, password: leaver.password })).status).toBe(
      401,
    );
  });
});
