import { describe, expect, it } from 'vitest';
import { anonymousClient, clientWithRoles, createRole, createUser, loginAs, takeMail } from './helpers';
import { db } from '../src/db/knex';
import { totpAt } from '../src/lib/totp';
import { loadBlueprint, parseBlueprint } from '@app/blueprints';
import { applyBlueprint } from '../src/blueprints/applier';
import { clearSettingsCache } from '../src/core/settings/settings.service';

describe('privilege escalation', () => {
  it('a user manager cannot make anyone an admin or touch admin accounts', async () => {
    const role = await createRole(['core.users.manage']);
    const { user: manager, client } = await clientWithRoles([role]);
    const res = await client.post('/users', {
      email: 'sneaky@example.test',
      firstName: 'S',
      roleKeys: ['admin'],
      sendInvite: false,
    });
    expect(res.status).toBe(403);
    await client.patch(`/users/${manager.uuid}`, { roleKeys: ['admin'] }).expect(403);
    const admin = await createUser({ roleKeys: ['admin'] });
    await client.post(`/users/${admin.uuid}/disable`).expect(403);
    await client.post(`/users/${admin.uuid}/reset-2fa`).expect(403);
  });

  it('a role manager cannot grant * or permissions they do not hold', async () => {
    const role = await createRole(['core.roles.manage', 'core.contacts.view'], { 'core.contacts': 'own' });
    const { client } = await clientWithRoles([role]);
    expect((await client.post('/roles', { key: 'god_mode', name: 'God', permissions: ['*'] })).status).toBe(
      422,
    );
    expect(
      (await client.post('/roles', { key: 'more', name: 'More', permissions: ['core.deals.view'] })).status,
    ).toBe(403);
    expect(
      (
        await client.post('/roles', {
          key: 'wider',
          name: 'Wider',
          permissions: ['core.contacts.view'],
          scopes: { 'core.contacts': 'all' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await client.post('/roles', {
          key: 'same',
          name: 'Same',
          permissions: ['core.contacts.view'],
          scopes: { 'core.contacts': 'own' },
        })
      ).status,
    ).toBe(201);
  });
});

describe('account lifecycle', () => {
  it('an invite link cannot reactivate a disabled user', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    takeMail();
    const created = await admin
      .post('/users', { email: 'temp@example.test', firstName: 'Temp', roleKeys: ['read_only'] })
      .expect(201);
    const [mail] = takeMail();
    const token = decodeURIComponent(/token=(\S+)/.exec(mail!.text)![1]!);
    await admin.post(`/users/${created.body.uuid}/disable`).expect(200);
    const anon = await anonymousClient();
    await anon.post('/auth/invite/accept', { token, password: 'GoodPassword123' }).expect(422);
    expect((await db('users').where({ uuid: created.body.uuid }).first()).status).toBe('disabled');
  });

  it('burns the 2FA challenge after five wrong codes', async () => {
    const user = await createUser();
    const c = await loginAs(user);
    const setup = await c.post('/me/2fa/setup').expect(200);
    await c.post('/me/2fa/enable', { code: totpAt(setup.body.secret, Date.now()) }).expect(204);
    const fresh = await anonymousClient();
    await fresh.post('/auth/login', { email: user.email, password: user.password }).expect(200);
    for (let i = 0; i < 5; i++) await fresh.post('/auth/2fa/verify', { code: '000000' });
    const valid = await fresh.post('/auth/2fa/verify', {
      code: totpAt(setup.body.secret, Date.now() + 30_000),
    });
    expect(valid.status).toBe(401);
    expect(valid.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('forces admins to enrol in 2FA when the policy requires it', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.patch('/settings/security', { totpRequiredForAdmins: true }).expect(200);
    clearSettingsCache();
    const res = await client.get('/roles');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
    await client.get('/me').expect(200);
    await client.post('/me/2fa/setup').expect(200);
    await db('settings')
      .where({ key: 'security' })
      .update({ value: JSON.stringify({ totpRequiredForAdmins: false }) });
    clearSettingsCache();
  });
});

describe('blueprints and admin-created config', () => {
  it('never adopts a role an admin created with the same key', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client
      .post('/roles', { key: 'field_agent', name: 'Field agent', permissions: ['core.contacts.view'] })
      .expect(201);
    const last = await db('blueprint_applications').orderBy('id', 'desc').first();
    const [major, minor] = (last.version as string).split('.').map(Number);
    const bp = structuredClone(loadBlueprint('generic'));
    bp.version = `${major}.${(minor ?? 0) + 10}.0`;
    bp.roles.push({
      key: 'field_agent',
      name: 'Agent',
      description: '',
      permissions: ['core.deals.*'],
      scopes: {},
    });
    const report = await applyBlueprint(db, parseBlueprint(bp));
    expect(report.conflicts.map((c) => c.item)).toContain('role.field_agent');
    const perms = await db('role_permissions as rp')
      .join('roles as r', 'r.id', 'rp.role_id')
      .where('r.key', 'field_agent')
      .pluck('rp.pattern');
    expect(perms).toEqual(['core.contacts.view']);
    expect(await db('audit_logs').where({ action: 'blueprint.applied' }).first()).toBeTruthy();
  });
});
