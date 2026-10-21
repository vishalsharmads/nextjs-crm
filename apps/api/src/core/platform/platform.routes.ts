import { z } from 'zod';
import { listBlueprintKeys, loadBlueprint, parseBlueprint } from '@app/blueprints';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import { applyBlueprint } from '../../blueprints/applier';
import { exportBlueprint } from '../../blueprints/exporter';
import { disableModule, enableModule, enabledModuleKeys, loadModules } from '../../modules/registry';

function bp(key: string) {
  if (!listBlueprintKeys().includes(key))
    throw new AppError('NOT_FOUND', `Blueprint "${key}" is not installed`);
  return loadBlueprint(key);
}

export const blueprintsRoutes = defineRoutes('/blueprints', ['platform'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.blueprints.manage',
    handler: async () => {
      const history = await db('blueprint_applications').orderBy('id', 'desc').limit(20);
      const available = listBlueprintKeys().map((key) => {
        const bp = loadBlueprint(key);
        return { key, name: bp.name, version: bp.version, description: bp.description, status: bp.status };
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
    params: z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) }),
    summary: 'Dry run: what applying this blueprint would change',
    handler: async ({ ctx, user, params }) =>
      applyBlueprint(db, bp(params.key), { dryRun: true, appliedBy: user.id, ctx }),
  })
  .add({
    method: 'post',
    path: '/:key/apply',
    permission: 'core.blueprints.manage',
    params: z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) }),
    handler: async ({ ctx, user, params }) => applyBlueprint(db, bp(params.key), { appliedBy: user.id, ctx }),
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
    method: 'post',
    path: '/:key/enable',
    permission: 'core.modules.manage',
    params: z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) }),
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
    params: z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/) }),
    handler: async ({ ctx, params }) => {
      if (!loadModules().some((m) => m.manifest.key === params.key))
        throw new AppError('NOT_FOUND', 'Module not found');
      await disableModule(params.key);
      await audit(db, ctx, { action: 'module.disabled', entity: 'module', diff: { key: params.key } });
    },
  });
