import { SCOPE_RANK, SCOPED_RESOURCES, hasPermission, type Scope } from '@app/shared';
import { db, type Db } from '../../db/knex';
import type { AuthUser } from '../../http/context';
import { AppError } from '../../lib/errors';
import { permissionCatalog } from './catalog';

const escalation = (message: string) => new AppError('FORBIDDEN', message);

/** Can the caller grant this permission pattern? Only if they already hold everything it covers. */
export function callerCoversPattern(caller: AuthUser, pattern: string): boolean {
  if (caller.isAdmin) return true;
  if (pattern === '*') return false;
  const keys = pattern.endsWith('.*')
    ? permissionCatalog()
        .map((p) => p.key)
        .filter((k) => k.startsWith(pattern.slice(0, -1)))
    : [pattern];
  return keys.length > 0 && keys.every((k) => hasPermission(caller.permissions, k));
}

export function callerCoversScopes(caller: AuthUser, scopes: Record<string, Scope>): boolean {
  if (caller.isAdmin) return true;
  return Object.entries(scopes).every(([resource, scope]) => {
    const resources = resource === '*' ? [...SCOPED_RESOURCES] : [resource];
    return resources.every((r) => SCOPE_RANK[caller.scopes[r] ?? 'own'] >= SCOPE_RANK[scope]);
  });
}

/** Non-admins may only grant permissions and scopes they hold themselves. `*` is admin-only. */
export function assertCanGrant(caller: AuthUser, permissions: string[], scopes: Record<string, Scope>) {
  const beyond = permissions.filter((p) => !callerCoversPattern(caller, p));
  if (beyond.length) throw escalation(`You cannot grant permissions you do not have: ${beyond.join(', ')}`);
  if (!callerCoversScopes(caller, scopes))
    throw escalation('You cannot grant wider record access than you have');
}

/** Check every role being assigned (or removed) is within the caller's own access. */
export async function assertCanAssignRoles(caller: AuthUser, roleIds: number[], conn: Db = db) {
  if (caller.isAdmin || !roleIds.length) return;
  const perms = await conn('role_permissions').whereIn('role_id', roleIds).pluck('pattern');
  const scopeRows = await conn('role_scopes').whereIn('role_id', roleIds).select('resource', 'scope');
  assertCanGrant(caller, perms as string[], Object.fromEntries(scopeRows.map((r) => [r.resource, r.scope])));
}

export async function isAdminUser(userId: number, conn: Db = db): Promise<boolean> {
  const row = await conn('user_roles as ur')
    .join('role_permissions as rp', 'rp.role_id', 'ur.role_id')
    .where({ 'ur.user_id': userId, 'rp.pattern': '*' })
    .first();
  return !!row;
}

/** Only admins can change, disable or reset an admin account. */
export async function assertCanManageUser(caller: AuthUser, targetId: number, conn: Db = db) {
  if (caller.isAdmin) return;
  if (await isAdminUser(targetId, conn)) throw escalation('Only admins can change an admin account');
}
