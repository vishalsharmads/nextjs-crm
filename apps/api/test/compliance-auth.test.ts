import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anonymousClient, clientWithRoles, createRole, createUser, loginAs, type TestUser } from './helpers';
import { db } from '../src/db/knex';
import { totpAt } from '../src/lib/totp';
import { clearSettingsCache } from '../src/core/settings/settings.service';

// Settings are shared by every test file, so each test restores the groups it touches.
const GROUPS = ['security', 'compliance'];
let saved: { key: string; value: unknown }[] = [];

beforeEach(async () => {
  saved = await db('settings').whereIn('key', GROUPS).select('key', 'value');
});

afterEach(async () => {
  await db('settings').whereIn('key', GROUPS).delete();
  for (const row of saved)
    await db('settings').insert({ key: row.key, group: row.key, value: JSON.stringify(row.value) });
  clearSettingsCache();
});

async function setCompliance(value: object) {
  await db('settings')
    .insert({ key: 'compliance', group: 'compliance', value: JSON.stringify(value) })
    .onConflict('key')
    .merge();
  clearSettingsCache();
}

async function enrol(user: TestUser) {
  const c = await loginAs(user);
  const setup = await c.post('/me/2fa/setup').expect(200);
  const enabled = await c.post('/me/2fa/enable', { code: totpAt(setup.body.secret, Date.now()) }).expect(200);
  return { client: c, secret: setup.body.secret as string, codes: enabled.body.recoveryCodes as string[] };
}

describe('compliance profile floors', () => {
  it('raises stored settings when the profile changes and rejects edits below the floor', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client
      .patch('/settings/security', { passwordMinLength: 8, passwordRequireMixed: false })
      .expect(200);

    const res = await client.patch('/settings/compliance', { profile: 'hipaa' }).expect(200);
    expect(res.body).toMatchObject({ mfaRequiredForAll: true, idleTimeoutMinutes: 15, sessionMaxHours: 12 });
    clearSettingsCache();
    const security = await db('settings').where({ key: 'security' }).first();
    expect(security.value).toMatchObject({ passwordMinLength: 12, passwordRequireMixed: true });
    expect(
      await db('audit_logs').where({ action: 'settings.updated' }).orderBy('id', 'desc').first(),
    ).toBeTruthy();

    // Every user (this admin included) must now enrol before doing anything else.
    expect((await client.get('/roles')).body.error.code).toBe('MFA_REQUIRED');
  });

  it('rejects lowering a governed value while the profile is active', async () => {
    await setCompliance({
      profile: 'hipaa',
      mfaRequiredForAll: true,
      idleTimeoutMinutes: 15,
      sessionMaxHours: 12,
    });
    // Enrolled admin, so the MFA gate does not get in the way.
    const admin = await createUser({ roleKeys: ['admin'] });
    const { client: enrolled } = await enrol(admin);

    const low = await enrolled.patch('/settings/security', { passwordMinLength: 8 });
    expect(low.status).toBe(422);
    expect(low.body.error.details[0].path).toBe('passwordMinLength');
    expect((await enrolled.patch('/settings/compliance', { idleTimeoutMinutes: 0 })).status).toBe(422);
    expect((await enrolled.patch('/settings/compliance', { idleTimeoutMinutes: 10 })).status).toBe(200);
  });

  it('applies floors on read even if the stored value is lower', async () => {
    await setCompliance({ profile: 'hipaa' });
    await db('settings')
      .insert({ key: 'security', group: 'security', value: JSON.stringify({ passwordMinLength: 8 }) })
      .onConflict('key')
      .merge();
    clearSettingsCache();
    const user = await createUser({ roleKeys: ['read_only'] });
    const c = await loginAs(user);
    // 11 characters with mixed case would pass a stored minimum of 8, but not the profile's 12.
    const res = await c.post('/me/password', { currentPassword: user.password, newPassword: 'Abcdefghij1' });
    expect(res.status).toBe(422);
  });
});

describe('two-factor requirements', () => {
  it('requires enrolment for members of a listed role', async () => {
    const role = await createRole(['core.contacts.view'], { 'core.contacts': 'own' });
    const { client } = await clientWithRoles([role]);
    await client.get('/contacts').expect(200);
    await setCompliance({ mfaRequiredRoles: [role] });
    const blocked = await client.get('/contacts');
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');
    await client.get('/me').expect(200);
  });

  it('does not let a required user turn 2FA off', async () => {
    const role = await createRole(['core.contacts.view'], { 'core.contacts': 'own' });
    const user = await createUser({ roleKeys: [role] });
    const { client } = await enrol(user);
    await setCompliance({ mfaRequiredRoles: [role] });
    await client.post('/me/2fa/disable', { password: user.password }).expect(403);
  });
});

describe('recovery codes', () => {
  it('signs in once per code and counts what is left', async () => {
    const user = await createUser({ roleKeys: ['read_only'] });
    const { codes } = await enrol(user);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    const first = await anonymousClient();
    await first.post('/auth/login', { email: user.email, password: user.password }).expect(200);
    await first.post('/auth/2fa/verify', { recoveryCode: codes[0]!.toUpperCase() }).expect(200);
    const me = await first.get('/me').expect(200);
    expect(me.body.recoveryCodesLeft).toBe(9);
    expect(
      await db('audit_logs').where({ action: 'auth.recovery_code_used', entity_id: user.id }).first(),
    ).toBeTruthy();

    const again = await anonymousClient();
    await again.post('/auth/login', { email: user.email, password: user.password }).expect(200);
    const reused = await again.post('/auth/2fa/verify', { recoveryCode: codes[0] });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('MFA_INVALID');
  });

  it('cannot re-enable 2FA to get new codes without the password', async () => {
    const user = await createUser({ roleKeys: ['read_only'] });
    const { client, secret } = await enrol(user);
    const again = await client.post('/me/2fa/enable', { code: totpAt(secret, Date.now() + 30_000) });
    expect(again.status).toBe(409);
  });

  it('regenerating replaces the old codes', async () => {
    const user = await createUser({ roleKeys: ['read_only'] });
    const { client, codes } = await enrol(user);
    await client.post('/me/2fa/recovery-codes', { password: 'wrong' }).expect(422);
    const fresh = await client.post('/me/2fa/recovery-codes', { password: user.password }).expect(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    const c = await anonymousClient();
    await c.post('/auth/login', { email: user.email, password: user.password }).expect(200);
    expect((await c.post('/auth/2fa/verify', { recoveryCode: codes[1] })).body.error.code).toBe(
      'MFA_INVALID',
    );
  });
});

describe('automatic logoff', () => {
  it('ends an idle session, even when the request claims recent input', async () => {
    await setCompliance({ idleTimeoutMinutes: 5 });
    const user = await createUser({ roleKeys: ['read_only'] });
    const c = await loginAs(user);
    await db('sessions')
      .where({ user_id: user.id })
      .update({ last_used_at: new Date(Date.now() - 6 * 60_000) });
    // A stolen cookie or a freshly reloaded tab reports "no idle time"; the stored clock still wins.
    expect((await c.get('/me').set('x-idle-ms', '0')).status).toBe(401);
    expect((await c.get('/me')).status).toBe(401);
    expect((await c.post('/auth/refresh').set('x-idle-ms', '0')).status).toBe(401);
    const expired = await db('audit_logs').where({ action: 'auth.session_expired', entity_id: user.id });
    expect(expired).toHaveLength(1);
    expect(
      await db('audit_logs').where({ action: 'auth.refresh_reuse', entity_id: user.id }).first(),
    ).toBeUndefined();
  });

  it('moves the idle clock forward only for reported input', async () => {
    await setCompliance({ idleTimeoutMinutes: 5 });
    const user = await createUser({ roleKeys: ['read_only'] });
    const c = await loginAs(user);
    const fourMinutesAgo = new Date(Date.now() - 4 * 60_000);
    await db('sessions').where({ user_id: user.id }).update({ last_used_at: fourMinutesAgo });
    const current = () => db('sessions').where({ user_id: user.id }).whereNull('revoked_at').first();

    await c.get('/me').expect(200); // no header: not activity
    expect(new Date((await current()).last_used_at).getTime()).toBe(
      Math.floor(fourMinutesAgo.getTime() / 1000) * 1000,
    );
    await c.post('/me/activity').set('x-idle-ms', '1000').expect(204);
    expect(Date.now() - new Date((await current()).last_used_at).getTime()).toBeLessThan(60_000);
  });

  it('a background refresh does not count as activity', async () => {
    await setCompliance({ idleTimeoutMinutes: 5 });
    const user = await createUser({ roleKeys: ['read_only'] });
    const c = await loginAs(user);
    const lastActive = new Date(Date.now() - 3 * 60_000);
    await db('sessions').where({ user_id: user.id }).update({ last_used_at: lastActive });
    await c
      .post('/auth/refresh')
      .set('x-idle-ms', String(3 * 60_000))
      .expect(200);
    const s = await db('sessions').where({ user_id: user.id }).whereNull('revoked_at').first();
    expect(Math.abs(new Date(s.last_used_at).getTime() - lastActive.getTime())).toBeLessThan(5_000);
  });

  it('ends a session older than the maximum age', async () => {
    await setCompliance({ sessionMaxHours: 1 });
    const user = await createUser({ roleKeys: ['read_only'] });
    const c = await loginAs(user);
    await db('sessions')
      .where({ user_id: user.id })
      .update({ family_started_at: new Date(Date.now() - 2 * 3_600_000) });
    expect((await c.get('/me')).status).toBe(401);
    expect((await c.post('/auth/refresh')).status).toBe(401);
  });
});

describe('who can change compliance settings', () => {
  it('limits security and compliance settings to admins and rejects unknown roles', async () => {
    const role = await createRole(['core.settings.manage']);
    const { client } = await clientWithRoles([role]);
    await client.patch('/settings/compliance', { profile: 'standard' }).expect(403);
    await client.patch('/settings/security', { lockoutMaxAttempts: 50 }).expect(403);
    await client.patch('/settings/general', { locale: 'en' }).expect(200);

    const { client: admin } = await clientWithRoles(['admin']);
    const res = await admin.patch('/settings/compliance', { mfaRequiredRoles: ['no_such_role'] });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].path).toBe('mfaRequiredRoles');
  });
});

describe('API keys under a compliance profile', () => {
  it('requires an expiry within the limit and stops keys older than it', async () => {
    const { client } = await clientWithRoles(['admin']);
    const legacy = await client.post('/api-keys', { name: 'Legacy', roleKey: 'read_only' }).expect(201);
    await setCompliance({ apiKeyMaxDays: 30 });

    expect((await client.post('/api-keys', { name: 'No expiry', roleKey: 'read_only' })).status).toBe(422);
    const far = new Date(Date.now() + 60 * 86_400_000).toISOString();
    expect(
      (await client.post('/api-keys', { name: 'Too long', roleKey: 'read_only', expiresAt: far })).status,
    ).toBe(422);
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await client.post('/api-keys', { name: 'Ok', roleKey: 'read_only', expiresAt: soon }).expect(201);

    const anon = await anonymousClient();
    await anon.get('/me').set('authorization', `Bearer ${legacy.body.secret}`).expect(200);
    await db('api_keys')
      .where({ uuid: legacy.body.uuid })
      .update({ created_at: new Date(Date.now() - 31 * 86_400_000) });
    expect((await anon.get('/me').set('authorization', `Bearer ${legacy.body.secret}`)).status).toBe(401);
  });
});

describe('login notice', () => {
  it('is public on the branding endpoint', async () => {
    await setCompliance({ loginNotice: 'Authorized use only.' });
    const anon = await anonymousClient();
    expect((await anon.get('/public/branding')).body.loginNotice).toBe('Authorized use only.');
  });
});
