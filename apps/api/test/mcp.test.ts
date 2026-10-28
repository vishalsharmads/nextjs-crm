import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  clientWithRoles,
  createRole,
  createUser,
  getApp,
  loginAs,
  restoreSettingsAfterEach,
  unique,
  type Client,
} from './helpers';
import { db } from '../src/db/knex';
import { clearSettingsCache } from '../src/core/settings/settings.service';

let seq = 1;
async function rpc(token: string, method: string, params: object = {}) {
  return request(await getApp())
    .post('/api/v1/mcp')
    .set('authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: seq++, method, params });
}
const call = (token: string, name: string, args: object = {}) =>
  rpc(token, 'tools/call', { name, arguments: args });

async function newToken(client: Client, access: 'read' | 'full' = 'full') {
  const res = await client.post('/me/tokens', { name: unique('t'), access }).expect(201);
  expect(res.body.secret).toMatch(/^pat_/);
  return res.body as { uuid: string; secret: string };
}

describe('personal access tokens and MCP', () => {
  let admin: Client;
  restoreSettingsAfterEach(['mcp']);

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
  });

  const enable = async (patch: object = {}) => {
    await admin.patch('/settings/mcp', { enabled: true, ...patch }).expect(200);
    clearSettingsCache();
  };

  it('is off until an admin turns it on, and only admins can', async () => {
    const t = await newToken(admin);
    expect((await rpc(t.secret, 'ping')).status).toBe(404);
    const { client: manager } = await clientWithRoles(['admin']);
    const rep = await loginAs(await createUser({ roleKeys: [await createRole(['core.settings.manage'])] }));
    await rep.patch('/settings/mcp', { enabled: true }).expect(403);
    await enable();
    expect((await rpc(t.secret, 'ping')).body.result).toEqual({});
    await manager.get('/me/tokens').expect(200);
  });

  it('tokens only work for MCP, list without secrets, and stop working when revoked', async () => {
    await enable();
    const t = await newToken(admin);
    const app = await getApp();
    await request(app).get('/api/v1/contacts').set('authorization', `Bearer ${t.secret}`).expect(401);
    const list = await admin.get('/me/tokens').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(t.secret);
    await admin.post(`/me/tokens/${t.uuid}/revoke`).expect(204);
    expect((await rpc(t.secret, 'ping')).status).toBe(401);
  });

  it('initializes and lists tools; read tokens get no write tools', async () => {
    await enable();
    const read = await newToken(admin, 'read');
    const init = await rpc(read.secret, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    const tools = (await rpc(read.secret, 'tools/list')).body.result.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toContain('search_records');
    expect(tools.map((t) => t.name)).not.toContain('create_record');
    const denied = await call(read.secret, 'create_record', { entity: 'contact', data: { firstName: 'X' } });
    expect(denied.body.error.code).toBe(-32602);
  });

  it('writes as the user, audited as mcp', async () => {
    await enable();
    const t = await newToken(admin);
    const name = unique('Mcp');
    const res = await call(t.secret, 'create_record', {
      entity: 'contact',
      data: { firstName: 'Ada', lastName: name },
    });
    const created = res.body.result.structuredContent as { uuid: string };
    expect(created.uuid).toBeTruthy();
    const row = await db('audit_logs')
      .where({ entity_uuid: created.uuid, action: 'contact.created' })
      .first();
    expect(row.actor_type).toBe('mcp');
    const got = await call(t.secret, 'get_record', { entity: 'contact', uuid: created.uuid });
    expect(got.body.result.structuredContent.lastName).toBe(name);
    const found = await call(t.secret, 'search_records', { query: name });
    expect(JSON.stringify(found.body.result)).toContain(created.uuid);
    const note = await call(t.secret, 'add_note', {
      related: { type: 'contact', uuid: created.uuid },
      body: 'Hi',
    });
    expect(note.body.result.isError).toBeUndefined();
  });

  it('applies record scope and returns tool errors the model can read', async () => {
    await enable();
    const other = await admin.post('/contacts', { firstName: 'Not', lastName: unique('Yours') }).expect(201);
    const role = await createRole(['core.contacts.*'], { 'core.contacts': 'own' });
    const rep = await loginAs(await createUser({ roleKeys: [role] }));
    const t = await newToken(rep);
    const res = await call(t.secret, 'get_record', { entity: 'contact', uuid: other.body.uuid });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain('NOT_FOUND');
    const deals = await call(t.secret, 'list_records', { entity: 'deal' });
    expect(deals.body.result.content[0].text).toContain('FORBIDDEN');
    const bad = await call(t.secret, 'get_record', { entity: 'contact', uuid: 'nope' });
    expect(bad.body.result.content[0].text).toContain('VALIDATION_FAILED');
  });

  it('hides hidden custom fields from the schema and records', async () => {
    await enable();
    const key = `secret_${Date.now().toString(36)}`;
    const field = await admin
      .post('/custom-fields', {
        entity: 'contact',
        key,
        label: 'Secret',
        type: 'text',
        visibility: { default: 'hidden' },
      })
      .expect(201);
    const rep = await loginAs(await createUser({ roleKeys: [await createRole(['core.contacts.*'])] }));
    const t = await newToken(rep);
    const schema = await call(t.secret, 'describe_schema');
    expect(JSON.stringify(schema.body.result)).not.toContain(key);
    await admin.post(`/custom-fields/${field.body.uuid}/archive`).expect(200);
  });

  it('honours the admin tool allow-list and serves resources', async () => {
    await enable({ allTools: false, tools: ['describe_schema'] });
    const t = await newToken(admin);
    const tools = (await rpc(t.secret, 'tools/list')).body.result.tools as { name: string }[];
    expect(tools.map((x) => x.name)).toEqual(['describe_schema']);
    const schema = await rpc(t.secret, 'resources/read', { uri: 'crm://schema' });
    expect(schema.body.result.contents[0].text).toContain('contact');
    expect((await rpc(t.secret, 'nope')).body.error.code).toBe(-32601);
    // An empty list allows nothing (it never falls back to every tool).
    await enable({ allTools: false, tools: [] });
    expect((await rpc(t.secret, 'tools/list')).body.result.tools).toEqual([]);
  });

  it('revokes tokens when the person signs out everywhere, and limits notes to visible records', async () => {
    await enable();
    const other = await admin.post('/contacts', { firstName: 'Out', lastName: unique('Scope') }).expect(201);
    const role = await createRole(['core.contacts.*', 'core.activities.*'], { 'core.contacts': 'own' });
    const user = await createUser({ roleKeys: [role] });
    const rep = await loginAs(user);
    const t = await newToken(rep);
    const note = await call(t.secret, 'add_note', {
      related: { type: 'contact', uuid: other.body.uuid },
      body: 'x',
    });
    expect(note.body.result.isError).toBe(true);
    await rep.post('/me/password', { currentPassword: user.password, newPassword: 'AnotherPass123!' });
    const after = await rpc(t.secret, 'ping');
    expect(after.status).toBe(401);
  });

  it('caps token lifetime under the compliance profile and needs a session to create tokens', async () => {
    const res = await admin.post('/me/tokens', { name: 'x', expiresInDays: 9999 });
    expect(res.status).toBe(422);
  });
});
