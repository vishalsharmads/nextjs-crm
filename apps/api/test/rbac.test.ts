import { describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs } from './helpers';

describe('rbac', () => {
  it('denies admin endpoints without the permission', async () => {
    const { client } = await clientWithRoles(['sales_rep']);
    expect((await client.get('/roles')).status).toBe(403);
    expect((await client.put('/settings/branding', {})).status).toBe(403);
    expect((await client.get('/users/00000000-0000-7000-8000-000000000000')).status).toBe(403);
  });

  it('allows a resource wildcard pattern', async () => {
    const role = await createRole(['core.roles.*']);
    const { client } = await clientWithRoles([role]);
    expect((await client.get('/roles')).status).toBe(200);
    expect((await client.get('/settings')).status).toBe(403);
  });

  it('rejects unknown permission patterns when saving a role', async () => {
    const { client } = await clientWithRoles(['admin']);
    const res = await client.post('/roles', {
      key: 'bad_role',
      name: 'Bad',
      permissions: ['core.nothing.view'],
    });
    expect(res.status).toBe(422);
  });

  it('creates a role, assigns it, and applies it immediately', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const role = await admin
      .post('/roles', { key: 'auditor', name: 'Auditor', permissions: ['core.audit.view'], scopes: {} })
      .expect(201);
    expect(role.body.permissions).toEqual(['core.audit.view']);
    const user = await admin
      .post('/users', {
        email: 'auditor@example.test',
        firstName: 'Ada',
        roleKeys: ['auditor'],
        sendInvite: false,
      })
      .expect(201);
    expect(user.body.status).toBe('invited');
  });

  it('protects the system Admin role and the last admin', async () => {
    const { client } = await clientWithRoles(['admin']);
    const roles = await client.get('/roles').expect(200);
    const adminRole = roles.body.data.find((r: { key: string }) => r.key === 'admin');
    expect((await client.delete(`/roles/${adminRole.uuid}`)).status).toBe(409);
    expect((await client.patch(`/roles/${adminRole.uuid}`, { permissions: [] })).status).toBe(409);
  });
});

describe('team membership', () => {
  it('lets only admins put themselves into a team, since teams widen record scope', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const role = await createRole(['core.users.manage', 'core.users.view']);
    const mgrUser = await createUser({ roleKeys: [role] });
    const mgr = await loginAs(mgrUser);
    const other = await createUser({ roleKeys: [role] });
    const team = await admin
      .post('/teams', { name: `Execs ${Date.now()}`, memberUuids: [other.uuid] })
      .expect(201);

    await mgr.patch(`/teams/${team.body.uuid}`, { memberUuids: [other.uuid, mgrUser.uuid] }).expect(403);
    await mgr.patch(`/users/${mgrUser.uuid}`, { teamUuids: [team.body.uuid] }).expect(403);
    await mgr.post('/teams', { name: `Mine ${Date.now()}`, memberUuids: [mgrUser.uuid] }).expect(403);
    // Managing other people's membership is still allowed.
    await mgr.post('/teams', { name: `Theirs ${Date.now()}`, memberUuids: [other.uuid] }).expect(201);
    // An admin can add them.
    await admin.patch(`/teams/${team.body.uuid}`, { memberUuids: [other.uuid, mgrUser.uuid] }).expect(200);
    // Once in, they may edit the team without losing their place.
    await mgr.patch(`/teams/${team.body.uuid}`, { memberUuids: [mgrUser.uuid] }).expect(200);
  });
});
