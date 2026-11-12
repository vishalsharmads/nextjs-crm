import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clientWithRoles, unique, type Client } from './helpers';
import { db } from '../src/db/knex';
import { clearModuleSettingsCache } from '../src/modules/module-settings';

let server: Server;
let received: { text: string }[] = [];
let status = 200;
let admin: Client;
let url = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (status === 200) received.push(JSON.parse(body) as { text: string });
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  ({ client: admin } = await clientWithRoles(['admin']));
  await admin.post('/modules/chat-notify/enable').expect(200);
});

afterAll(async () => {
  await admin.post('/modules/chat-notify/disable');
  await db('module_states').where({ module_key: 'chat-notify' }).update({ settings: null });
  clearModuleSettingsCache();
  server.close();
});

describe('chat notifications (example integration)', () => {
  it('requires the webhook address and tests the connection', async () => {
    const empty = await admin.patch('/modules/chat-notify/settings', { events: 'deals' });
    expect(empty.status).toBe(422);
    expect(empty.body.error.message).toContain('Incoming webhook address');

    const test = await admin.post('/modules/chat-notify/test', { webhook_url: url }).expect(200);
    expect(test.body).toEqual({ ok: true, message: 'Sent a test message. Check the channel.' });
    expect(received.pop()?.text).toContain('Test message');

    status = 403;
    const refused = await admin.post('/modules/chat-notify/test', { webhook_url: url }).expect(200);
    expect(refused.body).toMatchObject({ ok: false, message: expect.stringContaining('refused') });
    status = 200;
  });

  it('posts chosen events in the background, without titles unless allowed', async () => {
    await admin.patch('/modules/chat-notify/settings', { webhook_url: url, events: 'deals' }).expect(200);
    clearModuleSettingsCache();
    received = [];
    const title = unique('Big order');
    const deal = await admin.post('/deals', { title }).expect(201);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toMatch(/^New deal http.*\/deals\//);
    expect(received[0]!.text).toContain(deal.body.uuid as string);
    expect(received[0]!.text).not.toContain(title);

    await admin.patch('/modules/chat-notify/settings', { include_titles: true }).expect(200);
    clearModuleSettingsCache();
    await admin.post('/deals', { title }).expect(201);
    expect(received[1]!.text).toContain(title);

    // Leads are not in the "deals" choice.
    await admin.post('/leads', { firstName: 'Quiet', lastName: unique('Lead') }).expect(201);
    expect(received).toHaveLength(2);
  });

  it('never posts about a restricted person', async () => {
    await admin.patch('/modules/chat-notify/settings', { events: 'all' }).expect(200);
    clearModuleSettingsCache();
    received = [];
    const lead = await admin.post('/leads', { firstName: 'Kept', lastName: unique('Private') }).expect(201);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).not.toContain('Kept');
    await admin.post(`/privacy/lead/${lead.body.uuid}/restriction`, { restricted: true }).expect(204);
    await admin.patch(`/leads/${lead.body.uuid}`, { lastName: unique('Changed') }).expect(200);
    expect(received).toHaveLength(1);
  });

  it('stops when the module is turned off', async () => {
    await admin.post('/modules/chat-notify/disable').expect(204);
    received = [];
    await admin.post('/deals', { title: unique('Quiet') }).expect(201);
    expect(received).toHaveLength(0);
    await admin.post('/modules/chat-notify/enable').expect(200);
  });
});
