import { CORE_PERMISSIONS, type PermissionDef } from '@app/shared';
import { db, type Db } from '../../db/knex';

const moduleCatalog = new Map<string, PermissionDef[]>();

export function registerModulePermissions(moduleKey: string, perms: PermissionDef[]) {
  moduleCatalog.set(moduleKey, perms);
}

export function permissionCatalog(): (PermissionDef & { moduleKey: string })[] {
  return [
    ...CORE_PERMISSIONS.map((p) => ({ ...p, moduleKey: 'core' })),
    ...[...moduleCatalog.entries()].flatMap(([moduleKey, perms]) => perms.map((p) => ({ ...p, moduleKey }))),
  ];
}

export function isKnownPermissionPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  const catalog = permissionCatalog();
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return catalog.some((p) => p.key.startsWith(prefix));
  }
  return catalog.some((p) => p.key === pattern);
}

/** Mirror the in-code catalog into the permissions table (for reporting and FK-free lookups). */
export async function syncPermissions(conn: Db = db) {
  const catalog = permissionCatalog();
  if (!catalog.length) return;
  await conn('permissions')
    .insert(catalog.map((p) => ({ key: p.key, module_key: p.moduleKey, description: p.description })))
    .onConflict('key')
    .merge(['module_key', 'description']);
}
