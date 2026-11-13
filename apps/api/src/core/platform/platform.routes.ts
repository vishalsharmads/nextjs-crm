import { z } from 'zod';
import { listBlueprintKeys, loadBlueprint, parseBlueprint, type Blueprint } from '@app/blueprints';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import { applyBlueprint } from '../../blueprints/applier';
import { exportBlueprint } from '../../blueprints/exporter';
import {
  disableModule,
  enableModule,
  enabledModuleKeys,
  getModule,
  loadModules,
} from '../../modules/registry';
import { moduleSettingsDto, previewModuleSettings, saveModuleSettings } from '../../modules/module-settings';
import { logger } from '../../lib/logger';
import { catalogForMarketplace } from '../../modules/catalog';

function bp(key: string) {
  if (!listBlueprintKeys().includes(key))
    throw new AppError('NOT_FOUND', `Blueprint "${key}" is not installed`);
  return loadBlueprint(key);
}

/** What a preset brings, so admins can compare presets before previewing one. */
function contents(b: Blueprint) {
  const moduleNames = new Map(loadModules().map(({ manifest: m }) => [m.key, m.name]));
  return {
    vocabulary: Object.fromEntries(
      Object.entries(b.vocabulary ?? {}).map(([entity, v]) => [entity, v?.plural ?? v?.singular ?? entity]),
    ),
    modules: (b.modules ?? []).map((key) => ({ key, name: moduleNames.get(key) ?? key })),
    pipelines: (b.pipelines ?? []).map((p) => ({
      name: p.name,
      entity: p.entity,
      stages: p.stages.map((s) => s.name),
    })),
    customFields: Object.entries(b.custom_fields ?? {}).flatMap(([entity, fields]) =>
      (fields ?? []).map((f) => ({ entity, label: f.label, type: f.type })),
    ),
    roles: (b.roles ?? []).map((r) => r.name),
    templates: (b.templates ?? []).length,
    dashboardWidgets: b.dashboard?.widgets.length ?? 0,
    sampleData: Object.values(b.sample_data ?? {}).some((v) => Array.isArray(v) && v.length > 0),
  };
}

const keyParams = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) });
const modeQuery = z.object({ mode: z.enum(['primary', 'add']).default('primary') });

export const blueprintsRoutes = defineRoutes('/blueprints', ['platform'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.blueprints.manage',
    handler: async () => {
      const history = await db('blueprint_applications').orderBy('id', 'desc').limit(20);
      const available = listBlueprintKeys().map((key) => {
        const bp = loadBlueprint(key);
        return {
          key,
          name: bp.name,
          version: bp.version,
          description: bp.description,
          status: bp.status,
          contents: contents(bp),
        };
      });
      return {
        current: history[0]
          ? {
              key: history[0].blueprint_key,
              version: history[0].version,
              appliedAt: new Date(history[0].applied_at).toISOString(),
            }
          : null,
        available,
        history: history.map((h) => ({
          key: h.blueprint_key,
          version: h.version,
          appliedAt: new Date(h.applied_at).toISOString(),
          report: h.report,
        })),
      };
    },
  })
  .add({
    method: 'post',
    path: '/upload/preview',
    permission: 'core.blueprints.manage',
    body: z.object({ blueprint: z.unknown() }),
    summary: 'Validate and dry-run a blueprint file (e.g. an export from another instance)',
    handler: async ({ ctx, user, body }) => {
      const parsed = parseBlueprint(body.blueprint);
      return applyBlueprint(db, parsed, { dryRun: true, appliedBy: user.id, ctx });
    },
  })
  .add({
    method: 'post',
    path: '/:key/preview',
    permission: 'core.blueprints.manage',
    params: keyParams,
    query: modeQuery,
    summary: 'Dry run: what applying this blueprint would change',
    handler: async ({ ctx, user, params, query }) =>
      applyBlueprint(db, bp(params.key), { dryRun: true, appliedBy: user.id, ctx, mode: query.mode }),
  })
  .add({
    method: 'post',
    path: '/:key/apply',
    permission: 'core.blueprints.manage',
    params: keyParams,
    query: modeQuery,
    summary: 'Apply a blueprint; mode=add adds a second preset as if an admin made the changes',
    handler: async ({ ctx, user, params, query }) =>
      applyBlueprint(db, bp(params.key), { appliedBy: user.id, ctx, mode: query.mode }),
  })
  .add({
    method: 'get',
    path: '/export',
    permission: 'core.blueprints.manage',
    query: z.object({
      key: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,63}$/)
        .optional(),
      version: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/)
        .optional(),
    }),
    handler: async ({ res, ctx, query }) => {
      const bp = await exportBlueprint(db, query);
      await audit(db, ctx, {
        action: 'blueprint.exported',
        entity: 'blueprint',
        diff: { key: bp.key, version: bp.version },
      });
      res.setHeader('Content-Disposition', `attachment; filename="${bp.key}-${bp.version}.json"`);
      return bp;
    },
  });

export const modulesRoutes = defineRoutes('/modules', ['platform'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.modules.manage',
    handler: async () => {
      const enabled = new Set(enabledModuleKeys());
      const states = new Map((await db('module_states')).map((s) => [s.module_key as string, s]));
      return {
        data: loadModules().map(({ manifest: m, api }) => ({
          key: m.key,
          name: m.name,
          version: m.version,
          description: m.description,
          status: m.status,
          category: m.category,
          icon: m.icon,
          hasSettings: m.settings.length > 0,
          dependsOn: m.depends_on,
          enabled: enabled.has(m.key),
          installedVersion: (states.get(m.key)?.installed_version as string | null) ?? null,
          hasApi: !!api,
          permissions: m.permissions,
        })),
      };
    },
  })
  .add({
    method: 'get',
    path: '/catalog',
    permission: 'core.modules.manage',
    summary: 'Modules in the module catalog, compared with this build',
    handler: () => catalogForMarketplace(),
  })
  .add({
    method: 'get',
    path: '/:key',
    permission: 'core.modules.manage',
    params: keyParams,
    handler: async ({ params }) => {
      const mod = getModule(params.key);
      if (!mod) throw new AppError('NOT_FOUND', 'Module not found');
      const m = mod.manifest;
      const enabled = new Set(enabledModuleKeys());
      const state = await db('module_states').where({ module_key: m.key }).first('installed_version');
      const names = new Map(loadModules().map(({ manifest }) => [manifest.key, manifest.name]));
      return {
        key: m.key,
        name: m.name,
        version: m.version,
        description: m.description,
        status: m.status,
        category: m.category,
        icon: m.icon,
        enabled: enabled.has(m.key),
        installedVersion: (state?.installed_version as string | null | undefined) ?? null,
        dependsOn: m.depends_on.map((key) => ({
          key,
          name: names.get(key) ?? key,
          enabled: enabled.has(key),
        })),
        dependents: loadModules()
          .filter(({ manifest }) => manifest.depends_on.includes(m.key))
          .map(({ manifest }) => ({
            key: manifest.key,
            name: manifest.name,
            enabled: enabled.has(manifest.key),
          })),
        permissions: m.permissions,
        menuItems: m.menu_items.map((i) => ({ label: i.label, path: i.path })),
        canTest: !!mod.api?.testConnection,
        settings: await moduleSettingsDto(m.key),
      };
    },
  })
  .add({
    method: 'patch',
    path: '/:key/settings',
    permission: 'core.modules.manage',
    params: keyParams,
    body: z.record(z.string(), z.unknown()),
    handler: async ({ ctx, params, body }) => {
      if (!getModule(params.key)) throw new AppError('NOT_FOUND', 'Module not found');
      await db.transaction(async (trx) => {
        const diff = await saveModuleSettings(trx, params.key, body);
        if (Object.keys(diff).length)
          await audit(trx, ctx, {
            action: 'module.settings_changed',
            entity: 'module',
            diff: { key: params.key, changes: diff },
          });
      });
      return moduleSettingsDto(params.key);
    },
  })
  .add({
    method: 'post',
    path: '/:key/test',
    permission: 'core.modules.manage',
    params: keyParams,
    body: z.record(z.string(), z.unknown()).default({}),
    handler: async ({ ctx, params, body }) => {
      const mod = getModule(params.key);
      if (!mod?.api?.testConnection) throw new AppError('NOT_FOUND', 'This module has no connection to test');
      const settings = await previewModuleSettings(params.key, body);
      let result: { ok: boolean; message: string };
      try {
        result = { ok: true, ...(await mod.api.testConnection(settings)) };
      } catch (err) {
        // Only messages written for people pass through; anything else is logged, not shown.
        if (!(err instanceof AppError))
          logger.warn({ err, module: params.key }, 'module connection test failed');
        result = {
          ok: false,
          message:
            err instanceof AppError
              ? err.message
              : 'The connection failed. Check the settings and try again.',
        };
      }
      await audit(db, ctx, {
        action: 'module.connection_tested',
        entity: 'module',
        diff: { key: params.key, ok: result.ok },
      });
      return result;
    },
  })
  .add({
    method: 'post',
    path: '/:key/enable',
    permission: 'core.modules.manage',
    params: keyParams,
    handler: async ({ ctx, params }) => {
      const result = await enableModule(params.key);
      await audit(db, ctx, {
        action: 'module.enabled',
        entity: 'module',
        diff: { key: params.key, migrations: result.migrations },
      });
      return result;
    },
  })
  .add({
    method: 'post',
    path: '/:key/disable',
    permission: 'core.modules.manage',
    params: keyParams,
    handler: async ({ ctx, params }) => {
      if (!loadModules().some((m) => m.manifest.key === params.key))
        throw new AppError('NOT_FOUND', 'Module not found');
      await disableModule(params.key);
      await audit(db, ctx, { action: 'module.disabled', entity: 'module', diff: { key: params.key } });
    },
  });
