import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, unique, type Client } from './helpers';
import { db } from '../src/db/knex';

/** A scripted model provider: each request takes the next reply. */
let replies: unknown[] = [];
const seen: { url: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
let server: Server;
let base = '';

const text = (t: string) => ({
  content: [{ type: 'text', text: t }],
  usage: { input_tokens: 10, output_tokens: 5 },
});
const use = (name: string, input: object, id = `tu_${Math.random().toString(36).slice(2)}`) => ({
  content: [{ type: 'tool_use', id, name, input }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe('assistant module', () => {
  let admin: Client;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
        const next = replies.shift() ?? text('Done.');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(next));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ client: admin } = await clientWithRoles(['admin']));
    await admin.post('/modules/assistant/enable').expect(200);
    await admin
      .patch('/m/assistant/config', {
        provider: 'messages',
        baseUrl: base,
        model: 'test-model',
        apiKey: 'secret-key-123',
        headers: { 'x-api-version': '1' },
        userDailyTokenCap: 0,
      })
      .expect(200);
  });

  afterAll(async () => {
    server.close();
  });

  it('keeps the key secret and out of the audit log', async () => {
    const cfg = await admin.get('/m/assistant/config').expect(200);
    expect(cfg.body).toMatchObject({ hasApiKey: true, headerNames: ['x-api-version'] });
    expect(JSON.stringify(cfg.body)).not.toContain('secret-key-123');
    const audits = await db('audit_logs').where({ action: 'assistant.config.updated' });
    expect(JSON.stringify(audits)).not.toContain('secret-key-123');
    const row = await db('m_assistant_config').first();
    expect(row.api_key_enc).not.toContain('secret-key-123');
  });

  it('answers with read tools it runs on its own, as the person', async () => {
    const name = unique('Ask');
    await admin.post('/contacts', { firstName: 'Zed', lastName: name }).expect(201);
    replies = [use('search_records', { query: name }), text('I found Zed.')];
    seen.length = 0;
    const res = await admin.post('/m/assistant/conversations', { text: `Who is ${name}?` }).expect(201);
    expect(res.body.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'I found Zed.' });
    expect(seen[0]!.url).toBe('/v1/messages');
    expect(seen[0]!.headers['x-api-key']).toBe('secret-key-123');
    expect(seen[0]!.headers['x-api-version']).toBe('1');
    expect((seen[0]!.body.tools as { name: string }[]).map((t) => t.name)).toContain('create_record');
    // The tool result reached the model on the second call.
    expect(JSON.stringify(seen[1]!.body.messages)).toContain(name);
  });

  it('runs a change only after the person confirms it, audited as assistant', async () => {
    const last = unique('Made');
    replies = [
      use('create_record', { entity: 'contact', data: { firstName: 'Ann', lastName: last } }, 'tu_write'),
    ];
    const res = await admin.post('/m/assistant/conversations', { text: 'Add Ann' }).expect(201);
    expect(res.body.proposals).toEqual([expect.objectContaining({ id: 'tu_write', name: 'create_record' })]);
    expect(await db('contacts').where({ last_name: last }).first()).toBeUndefined();
    // No new message while a change waits for a decision.
    await admin.post(`/m/assistant/conversations/${res.body.uuid}/messages`, { text: 'hi' }).expect(409);

    replies = [text('Added Ann.')];
    const done = await admin
      .post(`/m/assistant/conversations/${res.body.uuid}/decisions`, { decisions: { tu_write: true } })
      .expect(200);
    expect(done.body.proposals).toEqual([]);
    const contact = await db('contacts').where({ last_name: last }).first();
    expect(contact).toBeTruthy();
    const audit = await db('audit_logs')
      .where({ entity: 'contact', entity_id: contact.id, action: 'contact.created' })
      .first();
    expect(audit.actor_type).toBe('assistant');
  });

  it('declined changes never run', async () => {
    const last = unique('Nope');
    replies = [
      use('create_record', { entity: 'contact', data: { firstName: 'No', lastName: last } }, 'tu_no'),
    ];
    const res = await admin.post('/m/assistant/conversations', { text: 'Add' }).expect(201);
    replies = [text('Okay.')];
    await admin
      .post(`/m/assistant/conversations/${res.body.uuid}/decisions`, { decisions: { tu_no: false } })
      .expect(200);
    expect(await db('contacts').where({ last_name: last }).first()).toBeUndefined();
  });

  it('keeps conversations private and applies permissions and scope to tools', async () => {
    const hidden = await admin.post('/contacts', { firstName: 'Hid', lastName: unique('Den') }).expect(201);
    const role = await createRole(['assistant.chat.use', 'core.contacts.view'], { 'core.contacts': 'own' });
    const rep = await loginAs(await createUser({ roleKeys: [role] }));
    replies = [use('get_record', { entity: 'contact', uuid: hidden.body.uuid }), text('Not found.')];
    seen.length = 0;
    const res = await rep.post('/m/assistant/conversations', { text: 'Show it' }).expect(201);
    expect(JSON.stringify(seen[1]!.body.messages)).toContain('NOT_FOUND');
    expect(JSON.stringify(seen[1]!.body.messages)).not.toContain(hidden.body.lastName);
    await admin.get(`/m/assistant/conversations/${res.body.uuid}`).expect(404);
    await rep.get('/m/assistant/config').expect(403);
  });

  it('refuses excluded record types and enforces the daily cap', async () => {
    await admin.patch('/m/assistant/config', { excludedEntities: ['deal'] }).expect(200);
    replies = [use('list_records', { entity: 'deal' }), text('Cannot.')];
    seen.length = 0;
    await admin.post('/m/assistant/conversations', { text: 'Deals?' }).expect(201);
    expect(JSON.stringify(seen[1]!.body.messages)).toContain('may not use this record type');
    await admin.patch('/m/assistant/config', { excludedEntities: [], userDailyTokenCap: 1 }).expect(200);
    const capped = await admin.post('/m/assistant/conversations', { text: 'Hi' });
    expect(capped.status).toBe(429);
    await admin.patch('/m/assistant/config', { userDailyTokenCap: 0 }).expect(200);
  });

  it('speaks the chat completions format too', async () => {
    await admin
      .patch('/m/assistant/config', { provider: 'chat_completions', baseUrl: `${base}/v1` })
      .expect(200);
    replies = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 'describe_schema', arguments: '{}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
      {
        choices: [{ message: { content: 'Here is the schema.' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    ];
    seen.length = 0;
    const res = await admin.post('/m/assistant/conversations', { text: 'What can you see?' }).expect(201);
    expect(res.body.messages.at(-1).text).toBe('Here is the schema.');
    expect(seen[0]!.url).toBe('/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBe('Bearer secret-key-123');
    const msgs = seen[1]!.body.messages as { role: string }[];
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    await admin.patch('/m/assistant/config', { provider: 'messages', baseUrl: base }).expect(200);
  });
});
