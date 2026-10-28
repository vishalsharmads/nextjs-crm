import {
  moduleManifestSchema,
  sortByDependencies,
  type ModuleManifest,
  type ModuleMenuItem,
} from '@app/module-sdk';
import { CUSTOM_OBJECTS_KEY } from '@app/shared';
import { db, type Db } from '../db/knex';
import { migrateModule } from '../db/migrate';
import { AppError } from '../lib/errors';
import { registerModulePermissions } from '../core/rbac/catalog';
import { setModuleGate, type RouteGroup } from '../http/routes';
import { registerRecordType, setRecordTypeGate } from '../core/records/registry';
import { recordTypeRouteGroups } from '../core/records/record-type-routes';
import { installedModuleSources } from './installed';
import type { ApiModule } from './types';

export interface LoadedModule {
  manifest: ModuleManifest;
  api?: ApiModule;
}

let modules: LoadedModule[] | null = null;

/** Parse and validate every installed module manifest (enabled or not). */
export function loadModules(): LoadedModule[] {
  if (modules) return modules;
  const parsed = installedModuleSources.map((src) => ({
    manifest: moduleManifestSchema.parse(src.manifest),
    api: src.api,
  }));
  const order = sortByDependencies(parsed.map((m) => m.manifest)).map((m) => m.key);
  modules = order.map((key) => parsed.find((m) => m.manifest.key === key)!);
  for (const m of modules) {
    if (m.manifest.key === CUSTOM_OBJECTS_KEY)
      throw new Error(`Module key "${CUSTOM_OBJECTS_KEY}" is reserved`);
    registerModulePermissions(m.manifest.key, m.manifest.permissions);
    for (const def of m.api?.recordTypes ?? []) {
      if (def.moduleKey !== m.manifest.key)
        throw new Error(`Record type "${def.entity}" belongs to module "${def.moduleKey}"`);
      // Records that link to or contact a person must reach data subject export and erasure.
      const personal = def.meta?.columns.some(
        (c) => c.kind === 'email' || c.kind === 'phone' || c.relation === 'contact' || c.relation === 'lead',
      );
      if (personal && !m.api?.privacy)
        throw new Error(
          `Module "${m.manifest.key}" stores personal data in "${def.entity}": add a privacy handler`,
        );
      registerRecordType(def);
    }
  }
  return modules;
}

export function getModule(key: string): LoadedModule | undefined {
  return loadModules().find((m) => m.manifest.key === key);
}

const enabled = new Set<string>();
let statesLoadedAt = 0;

export async function refreshModuleStates(conn: Db = db) {
  const rows = await conn('module_states').where({ enabled: true }).select('module_key');
  enabled.clear();
  for (const r of rows) enabled.add(r.module_key as string);
  statesLoadedAt = Date.now();
}

export function isModuleEnabled(key: string): boolean {
  if (Date.now() - statesLoadedAt > 10_000) void refreshModuleStates().catch(() => undefined);
  return enabled.has(key);
}

export function installModuleGate() {
  setModuleGate(isModuleEnabled);
  setRecordTypeGate(isModuleEnabled);
}

export async function enableModule(key: string, conn: Db = db): Promise<{ migrations: string[] }> {
  const mod = getModule(key);
  if (!mod) throw new AppError('NOT_FOUND', `Module "${key}" is not installed`);
  if (mod.manifest.status === 'stub') {
    throw new AppError('CONFLICT', `"${mod.manifest.name}" is not available yet`);
  }
  await refreshModuleStates(conn);
  const missing = mod.manifest.depends_on.filter((d) => !enabled.has(d));
  if (missing.length) throw new AppError('MODULE_DEPENDENCY', `Enable ${missing.join(', ')} first`);
  // Module migrations are DDL: run outside any business transaction.
  const migrations = mod.api?.migrations ? await migrateModule(db, key, mod.api.migrations) : [];
  await conn('module_states')
    .insert({ module_key: key, enabled: true, installed_version: mod.manifest.version })
    .onConflict('module_key')
    .merge({ enabled: true, installed_version: mod.manifest.version });
  await refreshModuleStates(conn);
  return { migrations };
}

export async function disableModule(key: string, conn: Db = db) {
  await refreshModuleStates(conn);
  const dependents = loadModules().filter(
    (m) => enabled.has(m.manifest.key) && m.manifest.depends_on.includes(key),
  );
  if (dependents.length) {
    throw new AppError(
      'MODULE_DEPENDENCY',
      `Disable ${dependents.map((d) => d.manifest.name).join(', ')} first`,
    );
  }
  // Disabling hides the module; its tables and data are never dropped.
  await conn('module_states')
    .insert({ module_key: key, enabled: false })
    .onConflict('module_key')
    .merge({ enabled: false });
  await refreshModuleStates(conn);
}

/** Route groups of every module with an API (gated per request by enabled state). */
export function moduleRouteGroups(): RouteGroup[] {
  return loadModules().flatMap((m) => [
    // Collection routes (/bulk, /export) and the module's own routes come before /:uuid.
    ...recordTypeRouteGroups(m.api?.recordTypes ?? [], 'collection'),
    ...(m.api?.routes?.() ?? []),
    ...recordTypeRouteGroups(m.api?.recordTypes ?? [], 'records'),
  ]);
}

export function moduleMenu(): ModuleMenuItem[] {
  return loadModules()
    .filter((m) => enabled.has(m.manifest.key))
    .flatMap((m) => m.manifest.menu_items.map((i) => ({ ...i, moduleKey: m.manifest.key })))
    .sort((a, b) => a.order - b.order);
}

export function enabledModuleKeys(): string[] {
  return [...enabled];
}
