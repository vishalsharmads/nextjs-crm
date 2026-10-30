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

/** The same scripted reply, as each format's stream of events (text in two pieces). */
function streamEvents(reply: Record<string, unknown>, url: string): object[] {
  if (url.includes('chat/completions')) {
    const msg = (
      reply.choices as {
        message: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[]
    )[0]!.message;
    const out: object[] = [];
    if (msg.content)
      for (const part of [msg.content.slice(0, 3), msg.content.slice(3)])
        out.push({ choices: [{ delta: { content: part } }] });
    (msg.tool_calls ?? []).forEach((c, index) =>
      out.push({
        choices: [
          {
            delta: {
              tool_calls: [
                { index, id: c.id, function: { name: c.function.name, arguments: c.function.arguments } },
              ],
            },
          },
        ],
      }),
    );
    out.push({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    return out;
  }
  const out: object[] = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }];
  (reply.content as { type: string; text?: string; id?: string; name?: string; input?: object }[]).forEach(
    (b, index) => {
      if (b.type === 'text') {
        out.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        for (const part of [b.text!.slice(0, 3), b.text!.slice(3)])
          out.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
      } else {
        out.push({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: b.id, name: b.name },
        });
        out.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
        });
      }
    },
  );
  out.push({ type: 'message_delta', usage: { output_tokens: 5 } });
  out.push({ type: 'message_stop' });
  return out;
}

/** Read a server-sent event response into its events. */
function events(textBody: string) {
  return textBody
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({
      event: /event: (.*)/.exec(block)?.[1],
      data: JSON.parse(/data: (.*)/.exec(block)?.[1] ?? 'null') as Record<string, unknown>,
    }));
}

describe('assistant module', () => {
  let admin: Client;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.method === 'GET' && (req.url ?? '').includes('/models')) {
          res.setHeader('content-type', 'application/json');
          const auth = req.headers['x-api-key'] ?? req.headers.authorization;
          if (!auth) {
            res.statusCode = 401;
            res.end('{}');
            return;
          }
          res.end(
            JSON.stringify({ data: [{ id: 'zeta-chat' }, { id: 'text-embedding-3' }, { id: 'test-model' }] }),
          );
          return;
        }
        seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
        const next = (replies.shift() ?? text('Done.')) as Record<string, unknown>;
        if (typeof next.status === 'number') {
          // A provider turning the request away (rate limit), asking to retry after a second.
          res.statusCode = next.status;
          res.setHeader('retry-after', '1');
          res.end('{"error":{"message":"slow down"}}');
          return;
        }
        const body = JSON.parse(raw || '{}') as { stream?: boolean };
        if (body.stream) {
          res.setHeader('content-type', 'text/event-stream');
          for (const e of streamEvents(next, req.url ?? '')) res.write(`data: ${JSON.stringify(e)}\n\n`);
          if ((req.url ?? '').includes('chat/completions')) res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
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
    // The lookup shows as a step on the answer, not as a bubble of its own.
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'I found Zed.',
      tools: [expect.any(String)],
    });
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
    expect(res.body.proposals).toEqual([expect.objectContaining({ id: 'p1', name: 'create_record' })]);
    expect(await db('contacts').where({ last_name: last }).first()).toBeUndefined();
    // No new message while a change waits for a decision.
    await admin.post(`/m/assistant/conversations/${res.body.uuid}/messages`, { text: 'hi' }).expect(409);

    replies = [text('Added Ann.')];
    const done = await admin
      .post(`/m/assistant/conversations/${res.body.uuid}/decisions`, { decisions: { p1: true } })
      .expect(200);
    expect(done.body.proposals).toEqual([]);
    const contact = await db('contacts').where({ last_name: last }).first();
    expect(contact).toBeTruthy();
    const audit = await db('audit_logs')
      .where({ entity: 'contact', entity_id: contact.id, action: 'contact.created' })
      .first();
    expect(audit.actor_type).toBe('assistant');
    // The same decision cannot run again.
    await admin
      .post(`/m/assistant/conversations/${res.body.uuid}/decisions`, { decisions: { p1: true } })
      .expect(409);
    expect(await db('contacts').where({ last_name: last })).toHaveLength(1);
  });

  it('never sends the saved key to a new address, and keeps app headers', async () => {
    await admin.patch('/m/assistant/config', { headers: { Authorization: 'x' } }).expect(422);
    const moved = await admin.patch('/m/assistant/config', { baseUrl: `${base}/elsewhere` }).expect(200);
    expect(moved.body.hasApiKey).toBe(false);
    await admin.patch('/m/assistant/config', { baseUrl: base, apiKey: 'secret-key-123' }).expect(200);
  });

  it('keeps excluded types out of search, stage moves and timelines', async () => {
    const name = unique('Excl');
    const d = await admin.post('/deals', { title: name }).expect(201);
    await admin.patch('/m/assistant/config', { excludedEntities: ['deal'] }).expect(200);
    replies = [
      use('search_records', { query: name }),
      use('get_timeline', { entity: 'contact', uuid: '00000000-0000-7000-8000-000000000000' }),
      text('ok'),
    ];
    seen.length = 0;
    await admin.post('/m/assistant/conversations', { text: 'x' }).expect(201);
    const sent = JSON.stringify(seen.at(-1)!.body.messages);
    expect(sent).not.toContain(d.body.uuid);
    expect(sent).toContain('may not use this record type');
    // A confirmed stage move on an excluded type is still refused.
    replies = [use('move_deal_stage', { dealUuid: d.body.uuid, stageUuid: d.body.stage.uuid }), text('ok')];
    const conv = await admin.post('/m/assistant/conversations', { text: 'move' }).expect(201);
    seen.length = 0;
    await admin
      .post(`/m/assistant/conversations/${conv.body.uuid}/decisions`, { decisions: { p1: true } })
      .expect(200);
    expect(JSON.stringify(seen[0]!.body.messages)).toContain('may not use this record type');
    await admin.patch('/m/assistant/config', { excludedEntities: [] }).expect(200);
  });

  it('erases conversations that mention a person, whatever the case', async () => {
    const email = `${unique('Mixed')}@Example.test`;
    const c = await admin.post('/contacts', { firstName: 'Era', lastName: unique('S'), email }).expect(201);
    replies = [text(`Their email is ${email.toUpperCase()}.`)];
    const conv = await admin.post('/m/assistant/conversations', { text: 'email?' }).expect(201);
    await admin.post(`/privacy/contact/${c.body.uuid}/anonymize`).expect(200);
    await admin.get(`/m/assistant/conversations/${conv.body.uuid}`).expect(404);
  });

  it('declined changes never run', async () => {
    const last = unique('Nope');
    replies = [
      use('create_record', { entity: 'contact', data: { firstName: 'No', lastName: last } }, 'tu_no'),
    ];
    const res = await admin.post('/m/assistant/conversations', { text: 'Add' }).expect(201);
    replies = [text('Okay.')];
    await admin
      .post(`/m/assistant/conversations/${res.body.uuid}/decisions`, { decisions: { p1: false } })
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
    // The model is told up front, so it can say so instead of trying.
    expect(String(seen[0]!.body.system)).toContain('kept these record types away from you: deal');
    await admin.patch('/m/assistant/config', { excludedEntities: [], userDailyTokenCap: 1 }).expect(200);
    const capped = await admin.post('/m/assistant/conversations', { text: 'Hi' });
    expect(capped.status).toBe(429);
    await admin.patch('/m/assistant/config', { userDailyTokenCap: 0 }).expect(200);
  });

  it('retries when the provider is busy, then says so plainly', async () => {
    replies = [{ status: 429 }, text('Back again.')];
    const ok = await admin.post('/m/assistant/conversations', { text: 'Hi' }).expect(201);
    expect(ok.body.messages.at(-1)).toMatchObject({ text: 'Back again.' });
    replies = [{ status: 429 }, { status: 429 }, { status: 429 }];
    const busy = await admin.post('/m/assistant/conversations', { text: 'Hi' });
    expect(busy.body.error.message).toMatch(/busy or this model's limit is used up/);
    expect(JSON.stringify(busy.body)).not.toContain('slow down');
  });

  it('streams text and tool steps as server-sent events', async () => {
    const name = unique('Stream');
    replies = [use('search_records', { query: name }), text('Hello there.')];
    const res = await admin
      .post('/m/assistant/conversations?stream=1', { text: 'Hi' })
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => cb(null, data));
      });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const evs = events(res.body as string);
    expect(
      evs
        .filter((e) => e.event === 'text')
        .map((e) => e.data.delta)
        .join(''),
    ).toBe('Hello there.');
    expect(evs.some((e) => e.event === 'tool')).toBe(true);
    const done = evs.find((e) => e.event === 'done')!;
    expect((done.data.messages as { text?: string }[]).at(-1)?.text).toBe('Hello there.');
  });

  it('speaks the chat completions format too', async () => {
    await admin
      .patch('/m/assistant/config', {
        provider: 'chat_completions',
        baseUrl: `${base}/v1`,
        apiKey: 'secret-key-123',
      })
      .expect(200);
    replies = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  function: { name: 'describe_schema', arguments: '{}' },
                  // Some providers sign each call and require the signature back unchanged.
                  extra_content: { sig: { thought_signature: 'abc==' } },
                },
              ],
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
    expect(JSON.stringify(msgs)).toContain('"extra_content":{"sig":{"thought_signature":"abc=="}}');
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    replies = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c2', function: { name: 'describe_schema', arguments: '{}' } }],
            },
          },
        ],
      },
      { choices: [{ message: { content: 'Streamed answer.' } }] },
    ];
    const streamed = await admin
      .post('/m/assistant/conversations?stream=1', { text: 'Again' })
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => cb(null, data));
      });
    const evs = events(streamed.body as string);
    expect(
      evs
        .filter((e) => e.event === 'text')
        .map((e) => e.data.delta)
        .join(''),
    ).toBe('Streamed answer.');
    await admin
      .patch('/m/assistant/config', { provider: 'messages', baseUrl: base, apiKey: 'secret-key-123' })
      .expect(200);
  });

  it('lists providers and fills in format, address and headers from the one picked', async () => {
    const list = await admin.get('/m/assistant/providers').expect(200);
    const ids = list.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['openai', 'gemini', 'mistral', 'groq']));
    const picked = await admin.patch('/m/assistant/config', { preset: 'openai' }).expect(200);
    expect(picked.body).toMatchObject({ preset: 'openai', provider: 'chat_completions', hasApiKey: false });
    expect(picked.body.baseUrl).toMatch(/^https:/);
    await admin.patch('/m/assistant/config', { preset: 'not-listed' }).expect(422);
    await admin
      .patch('/m/assistant/config', {
        preset: null,
        provider: 'messages',
        baseUrl: base,
        apiKey: 'secret-key-123',
      })
      .expect(200);
  });

  it('fetches chat models (saved key, saved address only) and tests the connection', async () => {
    const models = await admin.post('/m/assistant/models', {}).expect(200);
    expect(models.body.data.map((m: { id: string }) => m.id)).toEqual(['test-model', 'zeta-chat']);
    // The saved key is never sent to another address.
    await admin.post('/m/assistant/models', { provider: 'messages', baseUrl: `${base}/other` }).expect(422);
    replies = [text('ready')];
    const tested = await admin.post('/m/assistant/test').expect(200);
    expect(tested.body).toMatchObject({ ok: true, reply: 'ready' });
  });

  it('ranks recommended models first', async () => {
    const { rankModels } = await import('../../../modules/assistant/api/catalog');
    expect(rankModels(['a-large', 'b-mini-2', 'b-mini', 'c'], ['b-mini', 'x', 'a-'])).toEqual([
      { id: 'b-mini', recommended: true, best: true },
      { id: 'a-large', recommended: true, best: false },
      { id: 'b-mini-2', recommended: false, best: false },
      { id: 'c', recommended: false, best: false },
    ]);
  });

  it('sets up the workspace only for admins, once an admin turns it on', async () => {
    const role = await createRole(['assistant.chat.use', 'assistant.settings.manage']);
    const manager = await loginAs(await createUser({ roleKeys: [role] }));
    await manager.patch('/m/assistant/config', { setupEnabled: true }).expect(403);

    seen.length = 0;
    replies = [text('Hi.')];
    await admin.post('/m/assistant/conversations', { text: 'Hello' }).expect(201);
    const toolNames = () => (seen[0]!.body.tools as { name: string }[]).map((t) => t.name);
    expect(toolNames()).not.toContain('apply_setup');

    await admin.patch('/m/assistant/config', { setupEnabled: true }).expect(200);
    const key = `setup_${Date.now().toString(36)}`;
    const setup = { custom_fields: { contact: [{ key, label: 'Setup test', type: 'text' }] } };
    seen.length = 0;
    replies = [use('preview_setup', { setup }), use('apply_setup', { setup }, 'tu_setup')];
    const res = await admin.post('/m/assistant/conversations', { text: 'Set up for a clinic' }).expect(201);
    expect(toolNames()).toContain('apply_setup');
    // The preview ran on its own and changed nothing; the apply waits for the admin.
    expect(JSON.stringify(seen[1]!.body.messages)).toContain(`field.contact.${key}`);
    expect(res.body.proposals).toEqual([expect.objectContaining({ name: 'apply_setup' })]);
    expect(await db('custom_field_definitions').where({ key }).first()).toBeUndefined();

    replies = [text('Done.')];
    await admin
      .post(`/m/assistant/conversations/${res.body.uuid}/decisions`, { decisions: { p1: true } })
      .expect(200);
    const field = await db('custom_field_definitions').where({ key }).first();
    expect(field).toMatchObject({ source_blueprint: null });
    expect(field.customized).toBeTruthy();

    // Non-admins never get the setup tools, even with setup on.
    seen.length = 0;
    replies = [text('Hi.')];
    await manager.post('/m/assistant/conversations', { text: 'Hello' }).expect(201);
    expect(toolNames()).not.toContain('apply_setup');
    await admin.patch('/m/assistant/config', { setupEnabled: false }).expect(200);
  });
});
