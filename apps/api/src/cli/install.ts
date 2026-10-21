import type { Knex } from 'knex';
import { DEFAULT_BRANDING, SETTINGS_GROUPS, brandingSchema, type SettingsGroup } from '@app/shared';
import { newUuid } from '../lib/ids';
import { randomToken } from '../lib/crypto';
import { hashPassword } from '../core/auth/auth.service';
import { syncPermissions } from '../core/rbac/catalog';
import { clearSettingsCache } from '../core/settings/settings.service';
import { clearAccessCache } from '../core/rbac/access';

export interface InstallOptions {
  appName?: string;
  adminEmail: string;
  adminPassword?: string;
  adminFirstName?: string;
  adminLastName?: string;
}

/** Ensure the system Admin role exists with full access. */
export async function ensureAdminRole(conn: Knex | Knex.Transaction): Promise<number> {
  const existing = await conn('roles').where({ key: 'admin' }).first('id');
  if (existing) {
    await conn('roles').where({ id: existing.id }).update({ is_system: true });
    await conn('role_permissions')
      .insert({ role_id: existing.id, pattern: '*' })
      .onConflict(['role_id', 'pattern'])
      .ignore();
    await conn('role_scopes')
      .insert({ role_id: existing.id, resource: '*', scope: 'all' })
      .onConflict(['role_id', 'resource'])
      .merge();
    return existing.id as number;
  }
  const [id] = await conn('roles').insert({
    uuid: newUuid(),
    key: 'admin',
    name: 'Admin',
    description: 'Full access to everything, including settings',
    is_system: true,
  });
  await conn('role_permissions').insert({ role_id: id, pattern: '*' });
  await conn('role_scopes').insert({ role_id: id, resource: '*', scope: 'all' });
  return id!;
}

/** Seed defaults that are missing. Never overwrites an existing value. */
export async function seedDefaults(conn: Knex | Knex.Transaction, appName?: string) {
  const insertIfMissing = async (key: string, group: string, value: unknown, isPublic = false) => {
    await conn('settings')
      .insert({ key, group, value: JSON.stringify(value), is_public: isPublic })
      .onConflict('key')
      .ignore();
  };
  await insertIfMissing(
    'branding',
    'branding',
    brandingSchema.parse({ ...DEFAULT_BRANDING, appName: appName || DEFAULT_BRANDING.appName }),
    true,
  );
  await insertIfMissing('branding.assets', 'branding', {}, true);
  for (const group of Object.keys(SETTINGS_GROUPS) as SettingsGroup[]) {
    await insertIfMissing(group, group, SETTINGS_GROUPS[group].parse({}));
  }
  await conn('sequences')
    .insert({ key: 'deal', prefix: '', padding: 5, next_value: 1 })
    .onConflict('key')
    .ignore();
}

export interface AdminResult {
  email: string;
  created: boolean;
  generatedPassword?: string;
}

export async function ensureAdminUser(
  conn: Knex | Knex.Transaction,
  opts: InstallOptions,
  adminRoleId: number,
): Promise<AdminResult> {
  const email = opts.adminEmail.toLowerCase();
  const existing = await conn('users').where({ email }).first('id');
  if (existing) {
    await conn('user_roles')
      .insert({ user_id: existing.id, role_id: adminRoleId })
      .onConflict(['user_id', 'role_id'])
      .ignore();
    return { email, created: false };
  }
  const generatedPassword = opts.adminPassword ? undefined : `${randomToken(12)}Aa1`;
  const [id] = await conn('users').insert({
    uuid: newUuid(),
    email,
    first_name: opts.adminFirstName ?? 'Admin',
    last_name: opts.adminLastName ?? '',
    status: 'active',
    password_hash: await hashPassword(opts.adminPassword ?? generatedPassword!),
    password_changed_at: new Date(),
  });
  await conn('user_roles').insert({ user_id: id, role_id: adminRoleId });
  return { email, created: true, generatedPassword };
}

export async function markInstalled(conn: Knex | Knex.Transaction, blueprint: string | null) {
  const value = JSON.stringify({ installedAt: new Date().toISOString(), blueprint });
  await conn('settings').insert({ key: 'install', group: 'system', value }).onConflict('key').ignore();
}

/** Core install steps that run inside one transaction (no DDL here). */
export async function installCore(knex: Knex, opts: InstallOptions) {
  await syncPermissions(knex);
  const result = await knex.transaction(async (trx) => {
    const adminRoleId = await ensureAdminRole(trx);
    await seedDefaults(trx, opts.appName);
    return ensureAdminUser(trx, opts, adminRoleId);
  });
  clearSettingsCache();
  clearAccessCache();
  return result;
}
