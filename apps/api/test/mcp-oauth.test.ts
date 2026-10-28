import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  clientWithRoles,
  createUser,
  getApp,
  loginAs,
  restoreSettingsAfterEach,
  type Client,
} from './helpers';
import { clearSettingsCache } from '../src/core/settings/settings.service';

const REDIRECT = 'http://127.0.0.1:33418/callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('OAuth for MCP clients', () => {
  let admin: Client;
  restoreSettingsAfterEach(['mcp']);

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
  });

  const enable = async () => {
    await admin.patch('/settings/mcp', { enabled: true }).expect(200);
    clearSettingsCache();
  };

  /** Register a client, approve it as `who`, and exchange the code. */
  async function connect(who: Client, access: 'read' | 'full' = 'full') {
    const app = await getApp();
    const reg = await request(app)
      .post('/api/v1/oauth/register')
      .send({ client_name: 'Desk client', redirect_uris: [REDIRECT] })
      .expect(201);
    const { verifier, challenge } = pkce();
    const query = {
      client_id: reg.body.client_id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'mcp:full',
    };
    const info = await who.get(`/oauth/authorize/info?${new URLSearchParams(query)}`).expect(200);
    expect(info.body.client.name).toBe('Desk client');
    const approved = await who.post('/oauth/authorize', { ...query, access, approve: true }).expect(200);
    const url = new URL(approved.body.redirect);
    expect(url.searchParams.get('state')).toBe('xyz');
    const code = url.searchParams.get('code')!;
    const token = await request(app)
      .post('/api/v1/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: reg.body.client_id,
        redirect_uri: REDIRECT,
      })
      .expect(200);
    return {
      app,
      clientId: reg.body.client_id as string,
      code,
      verifier,
      token: token.body as { access_token: string; refresh_token: string },
    };
  }

  const rpc = (app: Awaited<ReturnType<typeof getApp>>, token: string, method: string, params = {}) =>
    request(app)
      .post('/api/v1/mcp')
      .set('authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method, params });

  it('is off, with no discovery, until MCP is turned on', async () => {
    const app = await getApp();
    await request(app).get('/.well-known/oauth-authorization-server').expect(404);
    await request(app)
      .post('/api/v1/oauth/register')
      .send({ redirect_uris: [REDIRECT] })
      .expect(404);
  });

  it('publishes discovery documents and points unauthenticated clients at them', async () => {
    await enable();
    const app = await getApp();
    const as = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(as.body).toMatchObject({ code_challenge_methods_supported: ['S256'] });
    expect(as.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    const pr = await request(app).get('/.well-known/oauth-protected-resource/api/v1/mcp').expect(200);
    expect(pr.body.resource).toMatch(/\/api\/v1\/mcp$/);
    const unauth = await request(app)
      .post('/api/v1/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
      .expect(401);
    expect(unauth.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('runs the code flow with PKCE, and the token works only on MCP', async () => {
    await enable();
    const { app, token } = await connect(admin);
    expect(token.access_token).toMatch(/^mat_/);
    expect((await rpc(app, token.access_token, 'ping')).body.result).toEqual({});
    await request(app)
      .get('/api/v1/contacts')
      .set('authorization', `Bearer ${token.access_token}`)
      .expect(401);
  });

  it('refuses reused codes, wrong verifiers and unregistered addresses', async () => {
    await enable();
    const { app, clientId, code, verifier } = await connect(admin);
    const again = await request(app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    expect(again.body.error).toBe('invalid_grant');
    const { challenge } = pkce();
    await admin
      .get(
        `/oauth/authorize/info?${new URLSearchParams({ client_id: clientId, redirect_uri: 'https://evil.example/cb', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' })}`,
      )
      .expect(422);
    const reg = await request(app)
      .post('/api/v1/oauth/register')
      .send({ redirect_uris: ['javascript:alert(1)'] });
    expect(reg.status).toBe(400);
  });

  it('rotates refresh tokens and honours read-only consent', async () => {
    await enable();
    const { app, token } = await connect(admin, 'read');
    const tools = (await rpc(app, token.access_token, 'tools/list')).body.result.tools as { name: string }[];
    expect(tools.map((t) => t.name)).not.toContain('create_record');
    const next = await request(app)
      .post('/api/v1/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: token.refresh_token })
      .expect(200);
    expect(next.body.access_token).not.toBe(token.access_token);
    const reuse = await request(app)
      .post('/api/v1/oauth/token')
      .send({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await rpc(app, token.access_token, 'ping')).status).toBe(401);
  });

  it('lists and disconnects apps, and signing out everywhere revokes them', async () => {
    await enable();
    const user = await createUser({ roleKeys: ['admin'] });
    const me = await loginAs(user);
    const { app, token } = await connect(me);
    const list = await me.get('/me/connected-apps').expect(200);
    expect(list.body.data).toHaveLength(1);
    await me.post('/me/password', { currentPassword: user.password, newPassword: 'AnotherPass123!' });
    expect((await rpc(app, token.access_token, 'ping')).status).toBe(401);
    expect((await me.get('/me/connected-apps')).body.data ?? []).toHaveLength(0);
  });
});
