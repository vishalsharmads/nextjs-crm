import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymousClient, clientWithRoles, createRole, getApp, takeMail } from './helpers';
import { db } from '../src/db/knex';
import { hmac } from '../src/lib/crypto';

// A local receiver for webhook deliveries.
const received: { headers: IncomingMessage['headers']; body: string }[] = [];
let failNext = 0;
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    res.statusCode = failNext-- > 0 ? 500 : 200;
    res.end('ok');
  });
});
let hookUrl = '';
beforeAll(async () => {
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});
afterAll(() => receiver.close());

describe('api keys', () => {
  it('authenticates with a bearer key limited to its role, and can be revoked', async () => {
    const { client } = await clientWithRoles(['admin']);
    const created = await client.post('/api-keys', { name: 'Zapier', roleKey: 'read_only' }).expect(201);
    expect(created.body.secret).toMatch(/^sk_/);
    const app = await getApp();
    const bearer = (path: string) =>
      request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${created.body.secret}`);
    await bearer('/contacts').expect(200);
    // Read-only role: writes are refused even without CSRF (bearer clients are exempt from CSRF).
    const write = await request(app)
      .post('/api/v1/contacts')
      .set('Authorization', `Bearer ${created.body.secret}`)
      .send({ firstName: 'Nope' });
    expect(write.status).toBe(403);
    await bearer('/roles').expect(403);
    await client.post(`/api-keys/${created.body.uuid}/revoke`).expect(204);
    await bearer('/contacts').expect(401);
    const list = await client.get('/api-keys').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
  });

  it('cannot mint a key with more access than its creator', async () => {
    const role = await createRole(['core.api_keys.manage', 'core.contacts.view']);
    const { client } = await clientWithRoles([role]);
    expect((await client.post('/api-keys', { name: 'Escalate', roleKey: 'admin' })).status).toBe(403);
  });
});

describe('webhooks', () => {
  it('delivers signed events and retries failures', async () => {
    const { client } = await clientWithRoles(['admin']);
    const hook = await client
      .post('/webhooks', { name: 'Receiver', url: hookUrl, events: ['contact.created', 'deal.won'] })
      .expect(201);
    received.length = 0;
    const contact = await client
      .post('/contacts', { firstName: 'Hooked', email: 'hooked@example.test' })
      .expect(201);
    const hit = received.find((r) => JSON.parse(r.body).data.uuid === contact.body.uuid);
    expect(hit).toBeTruthy();
    const ts = hit!.headers['x-webhook-timestamp'] as string;
    expect(hit!.headers['x-webhook-signature']).toBe(
      `sha256=${hmac(hook.body.secret, `${ts}.${hit!.body}`)}`,
    );
    expect(JSON.parse(hit!.body).type).toBe('contact.created');

    failNext = 1;
    await client.post('/contacts', { firstName: 'Retry' }).expect(201);
    const deliveries = await client.get(`/webhooks/${hook.body.uuid}/deliveries`).expect(200);
    const pending = deliveries.body.data.find((d: { status: string }) => d.status === 'pending');
    expect(pending.error).toBe('HTTP 500');
    await db('webhook_deliveries')
      .where({ uuid: pending.uuid })
      .update({ next_attempt_at: new Date(Date.now() - 1000) });
    const { retryDueWebhooks } = await import('../src/core/webhooks/webhooks');
    await retryDueWebhooks();
    expect((await db('webhook_deliveries').where({ uuid: pending.uuid }).first()).status).toBe('succeeded');
    await client.delete(`/webhooks/${hook.body.uuid}`).expect(204);
  });

  it('rejects non-http(s) URLs', async () => {
    const { client } = await clientWithRoles(['admin']);
    expect(
      (await client.post('/webhooks', { name: 'Bad', url: 'ftp://example.test/x', events: ['*'] })).status,
    ).toBe(422);
  });
});

describe('automations', () => {
  it('runs actions when the trigger and conditions match', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client
      .post('/automations', {
        name: 'Big deals get a follow-up',
        triggerEvent: 'deal.created',
        conditions: { field: 'value', op: 'gte', value: 10000 },
        actions: [
          { type: 'create_task', subject: 'Call about {{record.title}}', dueInDays: 1 },
          { type: 'add_tags', tags: ['big'] },
        ],
      })
      .expect(201);
    const small = await client.post('/deals', { title: 'Small one', value: 10 }).expect(201);
    const big = await client.post('/deals', { title: 'Whale', value: 50000 }).expect(201);
    const tasksBig = await client.get(`/activities/for?type=deal&uuid=${big.body.uuid}`).expect(200);
    expect(tasksBig.body.data.map((a: { subject: string }) => a.subject)).toContain('Call about Whale');
    expect(
      (await client.get(`/deals/${big.body.uuid}`)).body.tags.map((t: { name: string }) => t.name),
    ).toContain('big');
    expect((await client.get(`/activities/for?type=deal&uuid=${small.body.uuid}`)).body.data).toHaveLength(0);
  });

  it('stops automation loops', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client
      .post('/automations', {
        name: 'Ping-pong',
        triggerEvent: 'contact.updated',
        conditions: { field: 'changed', op: 'in', value: ['job_title'] },
        actions: [{ type: 'update_field', field: 'jobTitle', value: 'Loop' }],
      })
      .expect(201);
    const c = await client.post('/contacts', { firstName: 'Loopy' }).expect(201);
    await client.patch(`/contacts/${c.body.uuid}`, { jobTitle: 'Start' }).expect(200);
    const runs = await db('automation_runs as r')
      .join('automations as a', 'a.id', 'r.automation_id')
      .where('a.name', 'Ping-pong')
      .where('r.record_uuid', c.body.uuid);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThanOrEqual(3);
  });
});

describe('web forms', () => {
  it('accepts public submissions without a session or CSRF token and creates a lead', async () => {
    const { client } = await clientWithRoles(['admin']);
    const form = await client
      .post('/forms', {
        name: 'Website enquiry',
        entity: 'lead',
        fields: [
          { target: 'firstName', label: 'First name', required: true },
          { target: 'email', label: 'Email', required: true },
          { target: 'companyName', label: 'Company' },
        ],
        settings: { tags: ['web'], successMessage: 'Thanks!' },
      })
      .expect(201);
    const app = await getApp();
    const def = await request(app).get(`/api/v1/public/forms/${form.body.uuid}`).expect(200);
    expect(def.body.fields).toHaveLength(3);
    expect(JSON.stringify(def.body)).not.toContain('ownerUuid');
    await request(app)
      .post(`/api/v1/public/forms/${form.body.uuid}/submit`)
      .send({ firstName: 'Web' })
      .expect(422);
    const ok = await request(app)
      .post(`/api/v1/public/forms/${form.body.uuid}/submit`)
      .send({ firstName: 'Web', email: 'web@example.test', companyName: 'Formco' })
      .expect(200);
    expect(ok.body.message).toBe('Thanks!');
    const lead = await db('leads').where({ email: 'web@example.test' }).first();
    expect(lead.source).toBe('Web form');
    // Honeypot: silently accepted, nothing created.
    await request(app)
      .post(`/api/v1/public/forms/${form.body.uuid}/submit`)
      .send({ firstName: 'Bot', email: 'bot@example.test', website_url: 'http://spam' })
      .expect(200);
    expect(await db('leads').where({ email: 'bot@example.test' }).first()).toBeUndefined();
    // Other public POSTs still need CSRF.
    const anon = await anonymousClient();
    expect(
      (await anon.agent.post('/api/v1/auth/login').send({ email: 'x@example.test', password: 'x' })).status,
    ).toBe(403);
  });
});

describe('templates and email', () => {
  it('overrides a built-in template, rejects broken syntax, and previews', async () => {
    const { client } = await clientWithRoles(['admin']);
    const list = await client.get('/templates').expect(200);
    expect(
      list.body.data.some(
        (t: { key: string; builtIn: boolean }) => t.key === 'auth.password_reset' && t.builtIn,
      ),
    ).toBe(true);
    await client
      .post('/templates', {
        key: 'auth.invite',
        channel: 'email',
        name: 'Invite',
        subject: 'Join {{branding.appName}',
        body: '<p>x</p>',
      })
      .expect(422);
    await client
      .post('/templates', {
        key: 'auth.invite',
        channel: 'email',
        name: 'Invite',
        subject: 'Come aboard {{branding.appName}}',
        body: '<p>Hi {{user.firstName}}</p><a href="{{link}}">Go</a>',
      })
      .expect(201);
    takeMail();
    await client
      .post('/users', { email: 'templated@example.test', firstName: 'Tem', roleKeys: ['read_only'] })
      .expect(201);
    expect(takeMail()[0]?.subject).toBe('Come aboard Test CRM');
    const preview = await client
      .post('/templates/preview', {
        subject: 'Hello {{user.firstName}}',
        body: '<p>{{labels.contact.plural}}</p>',
      })
      .expect(200);
    expect(preview.body.subject).toBe('Hello Alex');
  });

  it('sends an email and logs it on the contact timeline', async () => {
    const { client } = await clientWithRoles(['admin']);
    const c = await client
      .post('/contacts', { firstName: 'Mailme', email: 'mailme@example.test' })
      .expect(201);
    takeMail();
    await client
      .post('/email/send', {
        to: ['mailme@example.test'],
        subject: 'Proposal',
        body: '<p>Attached <script>x</script></p>',
      })
      .expect(201);
    expect(takeMail()[0]?.to).toBe('mailme@example.test');
    const acts = await client.get(`/activities/for?type=contact&uuid=${c.body.uuid}`).expect(200);
    const email = acts.body.data.find((a: { type: string }) => a.type === 'email');
    expect(email.subject).toBe('Proposal');
    expect(email.body).not.toContain('script');
  });
});
