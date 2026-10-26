import { z } from 'zod';
import { PERMISSION_PATTERN_RE, SCOPES, listQuerySchema, type Scope, toPatch } from '@app/shared';
import type { AuthUser } from '../../http/context';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, conflict, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { env } from '../../config/env';
import { anonymizeUser } from '../privacy/staff';
import { audit } from '../audit/audit.service';
import { clearAccessCache } from '../rbac/access';
import { isKnownPermissionPattern, permissionCatalog } from '../rbac/catalog';
import { burnUserTokens, createOneTimeToken } from '../auth/tokens';
import { assertCanAssignRoles, assertCanGrant, assertCanManageUser } from '../rbac/grants';
import { escapeLike } from '../records/filters';
import { sendTemplatedEmail } from '../mail/templates';
import { recordDefs } from '../records/registry';

const uuidParam = z.object({ uuid: z.uuid() });

// ---------- Users ----------

const userInputSchema = z.object({
  email: z
    .email()
    .max(255)
    .transform((e) => e.toLowerCase()),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).default(''),
  roleKeys: z.array(z.string().max(64)).min(1).max(20),
  teamUuids: z.array(z.uuid()).max(50).default([]),
  sendInvite: z.boolean().default(true),
});

const userPatchSchema = toPatch(userInputSchema.omit({ sendInvite: true, email: true }));

async function roleIds(keys: string[]) {
  const rows = await db('roles').whereIn('key', keys).select('id', 'key');
  const missing = keys.filter((k) => !rows.some((r) => r.key === k));
  if (missing.length) throw new AppError('VALIDATION_FAILED', `Unknown role: ${missing.join(', ')}`);
  return rows.map((r) => r.id as number);
}

async function teamIds(uuids: string[]) {
  if (!uuids.length) return [];
  const rows = await db('teams').whereIn('uuid', uuids).select('id');
  if (rows.length !== uuids.length) throw new AppError('VALIDATION_FAILED', 'Unknown team');
  return rows.map((r) => r.id as number);
}

async function userDto(id: number) {
  const u = await db('users').where({ id }).first();
  if (!u) throw notFound('User');
  const roles = await db('user_roles as ur')
    .join('roles as r', 'r.id', 'ur.role_id')
    .where('ur.user_id', id)
    .select('r.key', 'r.name');
  const teams = await db('team_members as tm')
    .join('teams as t', 't.id', 'tm.team_id')
    .where('tm.user_id', id)
    .select('t.uuid', 't.name');
  return {
    uuid: u.uuid,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    status: u.status,
    totpEnabled: !!u.totp_enabled,
    lastLoginAt: u.last_login_at ? new Date(u.last_login_at).toISOString() : null,
    createdAt: new Date(u.created_at).toISOString(),
    roles,
    teams,
  };
}

async function sendInvite(userId: number, inviterName: string) {
  const u = await db('users').where({ id: userId }).first();
  const token = await createOneTimeToken(db, userId, 'invite', 7 * 24 * 60);
  await sendTemplatedEmail('auth.invite', u.email, {
    user: { firstName: u.first_name || u.email },
    inviter: inviterName,
    link: `${env.APP_URL}/accept-invite?token=${encodeURIComponent(token)}`,
  });
}

async function assertNotLastAdmin(userId: number) {
  const admins = await db('user_roles as ur')
    .join('roles as r', 'r.id', 'ur.role_id')
    .join('users as u', 'u.id', 'ur.user_id')
    .where('r.key', 'admin')
    .where('u.status', 'active')
    .whereNull('u.deleted_at')
    .distinct('ur.user_id');
  if (admins.length === 1 && admins[0]!.user_id === userId) {
    throw conflict('This is the only active admin. Make someone else an admin first.');
  }
}

export const usersRoutes = defineRoutes('/users', ['users'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated', // Everyone can list users (owner pickers, mentions); details are limited.
    query: listQuerySchema
      .pick({ page: true, pageSize: true, q: true })
      .extend({ status: z.enum(['invited', 'active', 'disabled']).optional() }),
    handler: async ({ query, user }) => {
      const base = db('users').whereNull('deleted_at');
      if (query.status) base.where({ status: query.status });
      if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        base.where((w) =>
          w.where('email', 'like', like).orWhereRaw("CONCAT(first_name, ' ', last_name) LIKE ?", [like]),
        );
      }
      const total = Number(((await base.clone().count({ c: '*' }).first()) as { c: number }).c);
      const rows = await base
        .clone()
        .orderBy([{ column: 'first_name' }, { column: 'last_name' }])
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const full = user.isAdmin || user.permissions.includes('core.users.manage');
      const data = full
        ? await Promise.all(rows.map((r) => userDto(r.id)))
        : rows.map((r) => ({
            uuid: r.uuid,
            firstName: r.first_name,
            lastName: r.last_name,
            email: r.email,
            status: r.status,
          }));
      return { data, meta: { page: query.page, pageSize: query.pageSize, total } };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'core.users.manage',
    params: uuidParam,
    handler: async ({ params }) => {
      const u = await db('users').where({ uuid: params.uuid }).whereNull('deleted_at').first('id');
      if (!u) throw notFound('User');
      return userDto(u.id);
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.users.manage',
    body: userInputSchema,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      if (await db('users').where({ email: body.email }).first('id'))
        throw conflict('A user with this email already exists');
      const rIds = await roleIds(body.roleKeys);
      await assertCanAssignRoles(user, rIds);
      const tIds = await teamIds(body.teamUuids);
      const id = await db.transaction(async (trx) => {
        const [newId] = await trx('users').insert({
          uuid: newUuid(),
          email: body.email,
          first_name: body.firstName,
          last_name: body.lastName,
          status: 'invited',
        });
        await trx('user_roles').insert(rIds.map((role_id) => ({ user_id: newId, role_id })));
        if (tIds.length)
          await trx('team_members').insert(tIds.map((team_id) => ({ team_id, user_id: newId })));
        await audit(trx, ctx, {
          action: 'user.created',
          entity: 'user',
          entityId: newId,
          diff: { email: body.email, roles: body.roleKeys },
        });
        return newId!;
      });
      if (body.sendInvite) await sendInvite(id, displayName(user));
      return userDto(id);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.users.manage',
    params: uuidParam,
    body: userPatchSchema,
    handler: async ({ ctx, user, params, body }) => {
      const u = await db('users').where({ uuid: params.uuid }).whereNull('deleted_at').first();
      if (!u) throw notFound('User');
      await assertCanManageUser(user, u.id);
      let rIds: number[] | null = null;
      if (body.roleKeys) {
        rIds = await roleIds(body.roleKeys);
        const current = (await db('user_roles').where({ user_id: u.id }).pluck('role_id')) as number[];
        // Both added and removed roles must be within the caller's own access.
        const changed = [
          ...rIds.filter((r) => !current.includes(r)),
          ...current.filter((r) => !rIds!.includes(r)),
        ];
        await assertCanAssignRoles(user, changed);
        if (!body.roleKeys.includes('admin')) {
          const isAdmin = await db('user_roles as ur')
            .join('roles as r', 'r.id', 'ur.role_id')
            .where({ 'ur.user_id': u.id, 'r.key': 'admin' })
            .first();
          if (isAdmin) await assertNotLastAdmin(u.id);
        }
      }
      const tIds = body.teamUuids ? await teamIds(body.teamUuids) : null;
      await db.transaction(async (trx) => {
        const patch: Record<string, unknown> = {};
        if (body.firstName !== undefined) patch.first_name = body.firstName;
        if (body.lastName !== undefined) patch.last_name = body.lastName;
        if (Object.keys(patch).length) await trx('users').where({ id: u.id }).update(patch);
        if (rIds) {
          await trx('user_roles').where({ user_id: u.id }).delete();
          await trx('user_roles').insert(rIds.map((role_id) => ({ user_id: u.id, role_id })));
        }
        if (tIds) {
          await trx('team_members').where({ user_id: u.id }).delete();
          if (tIds.length)
            await trx('team_members').insert(tIds.map((team_id) => ({ team_id, user_id: u.id })));
        }
        await audit(trx, ctx, {
          action: 'user.updated',
          entity: 'user',
          entityId: u.id,
          entityUuid: u.uuid,
          diff: body,
        });
      });
      clearAccessCache();
      return userDto(u.id);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/disable',
    permission: 'core.users.manage',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      const u = await db('users').where({ uuid: params.uuid }).whereNull('deleted_at').first();
      if (!u) throw notFound('User');
      if (u.id === user.id) throw conflict('You cannot disable your own account');
      await assertCanManageUser(user, u.id);
      await assertNotLastAdmin(u.id);
      await db.transaction(async (trx) => {
        await trx('users').where({ id: u.id }).update({ status: 'disabled' });
        await trx('sessions')
          .where({ user_id: u.id })
          .whereNull('revoked_at')
          .update({ revoked_at: new Date() });
        // Outstanding invite/reset links must not reactivate a disabled account.
        await burnUserTokens(trx, u.id);
        await audit(trx, ctx, {
          action: 'user.disabled',
          entity: 'user',
          entityId: u.id,
          entityUuid: u.uuid,
        });
      });
      return userDto(u.id);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/transfer-records',
    permission: 'core.users.manage',
    summary: "Hand a user's records (owner and assignee columns) to another active user",
    params: uuidParam,
    body: z.object({ toUuid: z.uuid() }),
    handler: async ({ ctx, user, params, body }) => {
      const from = await db('users').where({ uuid: params.uuid }).whereNull('deleted_at').first();
      if (!from) throw notFound('User');
      const to = await db('users').where({ uuid: body.toUuid }).whereNull('deleted_at').first();
      if (!to) throw notFound('User');
      if (from.id === to.id) throw new AppError('VALIDATION_FAILED', 'Choose a different user');
      if (to.status !== 'active') throw new AppError('VALIDATION_FAILED', 'The new owner must be active');
      await assertCanManageUser(user, from.id);
      const moved: Record<string, number> = {};
      await db.transaction(async (trx) => {
        for (const def of Object.values(recordDefs)) {
          let count = 0;
          for (const col of def.ownerColumns) {
            const column = col.split('.')[1]!;
            count += await trx(def.table)
              .where(column, from.id)
              .update({ [column]: to.id });
          }
          if (count) moved[def.entity] = count;
        }
        await audit(trx, ctx, {
          action: 'user.records_transferred',
          entity: 'user',
          entityId: from.id,
          entityUuid: from.uuid,
          diff: { to: to.uuid, moved },
        });
      });
      return { moved };
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/anonymize',
    permission: 'core.users.manage',
    params: uuidParam,
    summary: "Erase a disabled user's personal data (their audit trail stays, under an anonymous name)",
    handler: async ({ ctx, user, params }) => {
      const u = await db('users').where({ uuid: params.uuid }).first('id');
      if (!u) throw notFound('User');
      if (u.id === user.id) throw conflict('You cannot erase your own account');
      await assertCanManageUser(user, u.id);
      await anonymizeUser(ctx, params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/enable',
    permission: 'core.users.manage',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      const u = await db('users').where({ uuid: params.uuid }).whereNull('deleted_at').first();
      if (!u) throw notFound('User');
      await assertCanManageUser(user, u.id);
      await db.transaction(async (trx) => {
        await trx('users')
          .where({ id: u.id })
          .update({ status: u.password_hash ? 'active' : 'invited' });
        await audit(trx, ctx, { action: 'user.enabled', entity: 'user', entityId: u.id, entityUuid: u.uuid });
      });
      return userDto(u.id);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/resend-invite',
    permission: 'core.users.manage',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      const u = await db('users')
        .where({ uuid: params.uuid, status: 'invited' })
        .whereNull('deleted_at')
        .first();
      if (!u) throw notFound('Invited user');
      await assertCanManageUser(user, u.id);
      await sendInvite(u.id, displayName(user));
      await audit(db, ctx, { action: 'user.invite_resent', entity: 'user', entityId: u.id });
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/reset-2fa',
    permission: 'core.users.manage',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      const u = await db('users').where({ uuid: params.uuid }).whereNull('deleted_at').first();
      if (!u) throw notFound('User');
      await assertCanManageUser(user, u.id);
      await db.transaction(async (trx) => {
        await trx('users')
          .where({ id: u.id })
          .update({ totp_enabled: false, totp_secret_enc: null, totp_last_step: null });
        await trx('user_recovery_codes').where({ user_id: u.id }).delete();
        await audit(trx, ctx, { action: 'user.mfa_reset', entity: 'user', entityId: u.id });
      });
    },
  });

function displayName(u: AuthUser) {
  return `${u.firstName} ${u.lastName}`.trim() || u.email;
}

// ---------- Roles ----------

const permissionPattern = z
  .string()
  .regex(PERMISSION_PATTERN_RE)
  .refine((p) => p !== '*', 'Full access (*) belongs only to the system Admin role');

const roleInputSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
  permissions: z.array(permissionPattern).max(500),
  scopes: z.record(z.string().max(100), z.enum(SCOPES)).default({}),
});

async function roleDto(id: number) {
  const r = await db('roles').where({ id }).first();
  if (!r) throw notFound('Role');
  const perms = await db('role_permissions').where({ role_id: id }).pluck('pattern');
  const scopes = await db('role_scopes').where({ role_id: id }).select('resource', 'scope');
  const userCount = Number(
    ((await db('user_roles').where({ role_id: id }).count({ c: '*' }).first()) as { c: number }).c,
  );
  return {
    uuid: r.uuid,
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: !!r.is_system,
    permissions: perms as string[],
    scopes: Object.fromEntries(scopes.map((s) => [s.resource, s.scope])),
    userCount,
    sourceBlueprint: r.source_blueprint,
    customized: !!r.customized,
  };
}

function validatePatterns(patterns: string[]) {
  const unknown = patterns.filter((p) => !isKnownPermissionPattern(p));
  if (unknown.length) throw new AppError('VALIDATION_FAILED', `Unknown permission: ${unknown.join(', ')}`);
}

export async function writeRolePermissions(
  trx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  roleId: number,
  permissions: string[],
  scopes: Record<string, string>,
) {
  await trx('role_permissions').where({ role_id: roleId }).delete();
  if (permissions.length)
    await trx('role_permissions').insert(
      [...new Set(permissions)].map((pattern) => ({ role_id: roleId, pattern })),
    );
  await trx('role_scopes').where({ role_id: roleId }).delete();
  const entries = Object.entries(scopes);
  if (entries.length)
    await trx('role_scopes').insert(
      entries.map(([resource, scope]) => ({ role_id: roleId, resource, scope })),
    );
}

export const rolesRoutes = defineRoutes('/roles', ['roles'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.roles.manage',
    handler: async () => {
      const rows = await db('roles').orderBy('is_system', 'desc').orderBy('name').select('id');
      return { data: await Promise.all(rows.map((r) => roleDto(r.id))) };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'core.roles.manage',
    params: uuidParam,
    handler: async ({ params }) => {
      const r = await db('roles').where({ uuid: params.uuid }).first('id');
      if (!r) throw notFound('Role');
      return roleDto(r.id);
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.roles.manage',
    body: roleInputSchema,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      validatePatterns(body.permissions);
      assertCanGrant(user, body.permissions, body.scopes as Record<string, Scope>);
      if (await db('roles').where({ key: body.key }).first())
        throw conflict('A role with this key already exists');
      const id = await db.transaction(async (trx) => {
        // customized = true: blueprints never adopt or overwrite roles created here.
        const [rid] = await trx('roles').insert({
          uuid: newUuid(),
          key: body.key,
          name: body.name,
          description: body.description,
          customized: true,
        });
        await writeRolePermissions(trx, rid!, body.permissions, body.scopes);
        await audit(trx, ctx, { action: 'role.created', entity: 'role', entityId: rid, diff: body });
        return rid!;
      });
      clearAccessCache();
      return roleDto(id);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.roles.manage',
    params: uuidParam,
    body: toPatch(roleInputSchema.omit({ key: true })),
    handler: async ({ ctx, user, params, body }) => {
      const r = await db('roles').where({ uuid: params.uuid }).first();
      if (!r) throw notFound('Role');
      if (r.is_system && (body.permissions || body.scopes))
        throw conflict('The Admin role always has full access');
      if (body.permissions) validatePatterns(body.permissions);
      const current = await roleDto(r.id);
      // Editing a role is granting: the caller must cover both what it has now and what it will have.
      assertCanGrant(user, [...current.permissions, ...(body.permissions ?? [])], {
        ...current.scopes,
        ...(body.scopes ?? {}),
      } as Record<string, Scope>);
      await db.transaction(async (trx) => {
        const patch: Record<string, unknown> = { customized: true };
        if (body.name !== undefined) patch.name = body.name;
        if (body.description !== undefined) patch.description = body.description;
        await trx('roles').where({ id: r.id }).update(patch);
        if (body.permissions || body.scopes) {
          await writeRolePermissions(
            trx,
            r.id,
            body.permissions ?? current.permissions,
            body.scopes ?? current.scopes,
          );
        }
        await audit(trx, ctx, { action: 'role.updated', entity: 'role', entityId: r.id, diff: body });
      });
      clearAccessCache();
      return roleDto(r.id);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.roles.manage',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      const r = await db('roles').where({ uuid: params.uuid }).first();
      if (!r) throw notFound('Role');
      if (r.is_system) throw conflict('System roles cannot be deleted');
      const current = await roleDto(r.id);
      assertCanGrant(user, current.permissions, current.scopes as Record<string, Scope>);
      const inUse = await db('user_roles').where({ role_id: r.id }).first();
      if (inUse) throw conflict('Move users to another role before deleting this one');
      await db.transaction(async (trx) => {
        await trx('roles').where({ id: r.id }).delete();
        await audit(trx, ctx, {
          action: 'role.deleted',
          entity: 'role',
          entityId: r.id,
          diff: { key: r.key },
        });
      });
      clearAccessCache();
    },
  });

export const permissionsRoutes = defineRoutes('/permissions', ['roles']).add({
  method: 'get',
  path: '/',
  permission: 'core.roles.manage',
  handler: () => ({ data: permissionCatalog() }),
});

// ---------- Teams ----------

const teamInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  memberUuids: z.array(z.uuid()).max(500).default([]),
  leadUuids: z.array(z.uuid()).max(50).optional(),
});

async function teamDto(id: number) {
  const t = await db('teams').where({ id }).first();
  if (!t) throw notFound('Team');
  const members = await db('team_members as tm')
    .join('users as u', 'u.id', 'tm.user_id')
    .where('tm.team_id', id)
    .select('u.uuid', 'u.first_name', 'u.last_name', 'u.email', 'tm.is_lead');
  return {
    uuid: t.uuid,
    name: t.name,
    members: members.map((m) => ({
      uuid: m.uuid,
      firstName: m.first_name,
      lastName: m.last_name,
      email: m.email,
      isLead: !!m.is_lead,
    })),
  };
}

async function writeMembers(
  trx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  teamId: number,
  members: string[],
  leads: string[],
) {
  const users = members.length ? await trx('users').whereIn('uuid', members).select('id', 'uuid') : [];
  if (users.length !== new Set(members).size) throw new AppError('VALIDATION_FAILED', 'Unknown team member');
  if (leads.some((l) => !members.includes(l)))
    throw new AppError('VALIDATION_FAILED', 'Team leads must be members of the team');
  await trx('team_members').where({ team_id: teamId }).delete();
  if (users.length) {
    await trx('team_members').insert(
      users.map((u) => ({ team_id: teamId, user_id: u.id, is_lead: leads.includes(u.uuid) })),
    );
  }
}

export const teamsRoutes = defineRoutes('/teams', ['users'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    handler: async () => {
      const rows = await db('teams').orderBy('name').select('id');
      return { data: await Promise.all(rows.map((r) => teamDto(r.id))) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.users.manage',
    body: teamInputSchema,
    status: 201,
    handler: async ({ ctx, body }) => {
      if (await db('teams').where({ name: body.name }).first())
        throw conflict('A team with this name already exists');
      const id = await db.transaction(async (trx) => {
        const [tid] = await trx('teams').insert({ uuid: newUuid(), name: body.name });
        await writeMembers(trx, tid!, body.memberUuids, body.leadUuids ?? []);
        await audit(trx, ctx, { action: 'team.created', entity: 'team', entityId: tid, diff: body });
        return tid!;
      });
      clearAccessCache();
      return teamDto(id);
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.users.manage',
    params: uuidParam,
    body: toPatch(teamInputSchema),
    handler: async ({ ctx, params, body }) => {
      const t = await db('teams').where({ uuid: params.uuid }).first();
      if (!t) throw notFound('Team');
      const current = await teamDto(t.id);
      await db.transaction(async (trx) => {
        if (body.name) await trx('teams').where({ id: t.id }).update({ name: body.name });
        if (body.memberUuids || body.leadUuids) {
          const members = body.memberUuids ?? current.members.map((m) => m.uuid);
          // Omitted leads keep the existing leads (that are still members).
          const leads =
            body.leadUuids ??
            current.members.filter((m) => m.isLead && members.includes(m.uuid)).map((m) => m.uuid);
          await writeMembers(trx, t.id, members, leads);
        }
        await audit(trx, ctx, { action: 'team.updated', entity: 'team', entityId: t.id, diff: body });
      });
      clearAccessCache();
      return teamDto(t.id);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.users.manage',
    params: uuidParam,
    handler: async ({ ctx, params }) => {
      const t = await db('teams').where({ uuid: params.uuid }).first();
      if (!t) throw notFound('Team');
      await db.transaction(async (trx) => {
        await trx('teams').where({ id: t.id }).delete();
        await audit(trx, ctx, {
          action: 'team.deleted',
          entity: 'team',
          entityId: t.id,
          diff: { name: t.name },
        });
      });
      clearAccessCache();
    },
  });
