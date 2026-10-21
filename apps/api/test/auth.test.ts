import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { anonymousClient, createUser, getApp, loginAs, takeMail } from './helpers';
import { db } from '../src/db/knex';
import { totpAt } from '../src/lib/totp';

describe('auth', () => {
  it('rejects mutating requests without a CSRF token', async () => {
    const c = await anonymousClient();
    const res = await c.agent.post('/api/v1/auth/login').send({ email: 'x@example.test', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('logs in, returns the profile, and logs out', async () => {
    const user = await createUser({ roleKeys: ['read_only'] });
    const c = await loginAs(user);
    const me = await c.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(user.email);
    expect(me.body.roles.map((r: { key: string }) => r.key)).toEqual(['read_only']);
    await c.post('/auth/logout').expect(204);
    const after = await c.get('/me');
    expect(after.status).toBe(401);
  });

  it('uses the same error for unknown email and wrong password', async () => {
    const user = await createUser();
    const c = await anonymousClient();
    const a = await c.post('/auth/login', { email: 'nobody@example.test', password: 'Password123!' });
    const b = await c.post('/auth/login', { email: user.email, password: 'wrong-password' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('locks the account after repeated failures', async () => {
    const user = await createUser();
    const c = await anonymousClient();
    for (let i = 0; i < 4; i++)
      await c.post('/auth/login', { email: user.email, password: 'nope' }).expect(401);
    const fifth = await c.post('/auth/login', { email: user.email, password: 'nope' });
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
    const correct = await c.post('/auth/login', { email: user.email, password: user.password });
    expect(correct.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const user = await createUser();
    const c = await loginAs(user);
    const firstRefresh = c.agent.jar.getCookie('refresh_token', {
      path: '/api/v1/auth',
      domain: '127.0.0.1',
      secure: false,
      script: false,
    })?.value;
    expect(firstRefresh).toBeTruthy();
    await c.post('/auth/refresh').expect(200);
    // Replay the old (rotated) token from a different client.
    const attacker = await anonymousClient();
    const replay = await request(await getApp())
      .post('/api/v1/auth/refresh')
      .set('x-csrf-token', attacker.csrf)
      .set('Cookie', `refresh_token=${firstRefresh}; csrf_token=${attacker.csrf}`);
    expect(replay.status).toBe(401);
    // The legitimate session is now revoked too.
    const legit = await c.post('/auth/refresh');
    expect(legit.status).toBe(401);
  });

  it('resets a password via the emailed link and ends other sessions', async () => {
    const user = await createUser();
    const session = await loginAs(user);
    takeMail();
    const c = await anonymousClient();
    await c.post('/auth/password/forgot', { email: user.email }).expect(204);
    const [mail] = takeMail();
    expect(mail?.to).toBe(user.email);
    expect(mail?.subject).toContain('Test CRM');
    const token = decodeURIComponent(/token=(\S+)/.exec(mail!.text)![1]!);
    await c.post('/auth/password/reset', { token, password: 'weak' }).expect(422);
    await c.post('/auth/password/reset', { token, password: 'BrandNewPass123' }).expect(204);
    await c.post('/auth/password/reset', { token, password: 'BrandNewPass123' }).expect(422);
    expect((await session.get('/me')).status).toBe(401);
    await loginAs({ ...user, password: 'BrandNewPass123' });
  });

  it('does not reveal whether an email exists on forgot-password', async () => {
    const c = await anonymousClient();
    takeMail();
    await c.post('/auth/password/forgot', { email: 'ghost@example.test' }).expect(204);
    expect(takeMail()).toHaveLength(0);
  });

  it('requires a TOTP code when 2FA is enabled', async () => {
    const user = await createUser();
    const c = await loginAs(user);
    const setup = await c.post('/me/2fa/setup').expect(200);
    expect(setup.body.otpauthUrl).toContain('otpauth://totp/');
    await c.post('/me/2fa/enable', { code: '000000' }).expect(401);
    await c.post('/me/2fa/enable', { code: totpAt(setup.body.secret, Date.now()) }).expect(204);

    const fresh = await anonymousClient();
    const first = await fresh.post('/auth/login', { email: user.email, password: user.password }).expect(200);
    expect(first.body.mfaRequired).toBe(true);
    expect((await fresh.get('/me')).status).toBe(401);
    await fresh.post('/auth/2fa/verify', { code: '123456' }).expect(401);
    // The code used to enable 2FA cannot be replayed; the next time step's code works.
    await fresh.post('/auth/2fa/verify', { code: totpAt(setup.body.secret, Date.now()) }).expect(401);
    await fresh
      .post('/auth/2fa/verify', { code: totpAt(setup.body.secret, Date.now() + 30_000) })
      .expect(200);
    expect((await fresh.get('/me')).status).toBe(200);
  });

  it('lists sessions and revokes one', async () => {
    const user = await createUser();
    const a = await loginAs(user);
    const b = await loginAs(user);
    const list = await a.get('/me/sessions').expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    await a.delete(`/me/sessions/${other.uuid}`).expect(204);
    expect((await b.get('/me')).status).toBe(401);
    expect((await a.get('/me')).status).toBe(200);
  });

  it('writes audit entries for logins', async () => {
    const user = await createUser();
    await loginAs(user);
    const row = await db('audit_logs').where({ action: 'auth.login', entity_id: user.id }).first();
    expect(row).toBeTruthy();
  });
});
