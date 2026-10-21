import type { Knex } from 'knex';
import { SCOPE_RANK, SCOPED_RESOURCES, hasPermission, type Scope } from '@app/shared';
import { db, type Db } from '../../db/knex';
import type { AuthUser } from '../../http/context';
import { AppError } from '../../lib/errors';

export interface UserAccess {
  roleKeys: string[];
  isAdmin: boolean;
  permissions: string[];
  scopes: Record<string, Scope>;
}

const TTL_MS = 10_000;
const cache = new Map<number, { access: UserAccess; at: number }>();

/** Call after any change to roles, role permissions, scopes or user-role assignments. */
export function clearAccessCache() {
  cache.clear();
}

export async function loadAccess(userId: number, conn: Db = db): Promise<UserAccess> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.access;

  const roles = await conn('user_roles as ur')
    .join('roles as r', 'r.id', 'ur.role_id')
    .where('ur.user_id', userId)
    .select('r.id', 'r.key');
  const roleIds = roles.map((r) => r.id as number);
  const roleKeys = roles.map((r) => r.key as string);

  const perms = roleIds.length
    ? await conn('role_permissions').whereIn('role_id', roleIds).distinct('pattern')
    : [];
  const permissions = perms.map((p) => p.pattern as string);
  const isAdmin = permissions.includes('*');

  const scopeRows = roleIds.length
    ? await conn('role_scopes').whereIn('role_id', roleIds).select('resource', 'scope')
    : [];
  const scopes: Record<string, Scope> = {};
  for (const resource of SCOPED_RESOURCES) {
    let best: Scope | null = isAdmin ? 'all' : null;
    for (const row of scopeRows) {
      if (row.resource !== resource && row.resource !== '*' && !resource.startsWith(`${row.resource}.`))
        continue;
      const s = row.scope as Scope;
      if (!best || SCOPE_RANK[s] > SCOPE_RANK[best]) best = s;
    }
    scopes[resource] = best ?? 'own';
  }

  const access = { roleKeys, isAdmin, permissions, scopes };
  cache.set(userId, { access, at: Date.now() });
  return access;
}

export function can(user: AuthUser, permission: string): boolean {
  return user.isAdmin || hasPermission(user.permissions, permission);
}

export function assertCan(user: AuthUser, permission: string) {
  if (!can(user, permission)) throw new AppError('FORBIDDEN', 'You do not have permission to do that');
}

export async function teamUserIds(userId: number, conn: Db = db): Promise<number[]> {
  const rows = await conn('team_members as me')
    .join('team_members as tm', 'tm.team_id', 'me.team_id')
    .where('me.user_id', userId)
    .distinct('tm.user_id');
  const ids = rows.map((r) => r.user_id as number);
  return ids.includes(userId) ? ids : [...ids, userId];
}

/**
 * Restrict a query to records the user may see for a scoped resource.
 * `ownerColumns` are OR-ed (e.g. activities: assignee or owner).
 */
export async function applyScope(
  qb: Knex.QueryBuilder,
  user: AuthUser,
  resource: string,
  ownerColumns: string[],
  conn: Db = db,
) {
  const scope = user.isAdmin ? 'all' : (user.scopes[resource] ?? 'own');
  if (scope === 'all') return qb;
  const ids = scope === 'team' ? await teamUserIds(user.id, conn) : [user.id];
  return qb.where((w) => {
    for (const col of ownerColumns) w.orWhereIn(col, ids);
  });
}

export async function scopeAllows(
  user: AuthUser,
  resource: string,
  ownerIds: (number | null)[],
  conn: Db = db,
): Promise<boolean> {
  const scope = user.isAdmin ? 'all' : (user.scopes[resource] ?? 'own');
  if (scope === 'all') return true;
  const ids = scope === 'team' ? await teamUserIds(user.id, conn) : [user.id];
  return ownerIds.some((o) => o !== null && ids.includes(o));
}
