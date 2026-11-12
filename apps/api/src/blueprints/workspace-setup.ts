import { z } from 'zod';
import { blueprintSchema, listBlueprintKeys, loadBlueprint, parseBlueprint } from '@app/blueprints';
import { db } from '../db/knex';
import type { AuthUser, RequestContext } from '../http/context';
import { AppError } from '../lib/errors';
import { getLabels } from '../core/labels/labels.service';
import { enabledModuleKeys, loadModules } from '../modules/registry';
import { applyBlueprint, BlueprintError, type ApplyReport } from './applier';

/**
 * Workspace setup drafted by someone (the assistant, for an admin) rather than shipped as a preset:
 * names, settings, modules, field groups, custom fields, pipelines and roles. Applied in `add` mode,
 * so it only creates what is missing, as the admin's own changes.
 */
export const setupDraftSchema = blueprintSchema
  .pick({
    settings: true,
    vocabulary: true,
    modules: true,
    custom_field_groups: true,
    custom_fields: true,
    pipelines: true,
    roles: true,
  })
  .partial();
export type SetupDraft = z.infer<typeof setupDraftSchema>;

/** Blueprint and schema errors become validation errors the admin (or the assistant) can act on. */
async function asAppError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BlueprintError) throw new AppError('VALIDATION_FAILED', err.message);
    if (err instanceof z.ZodError)
      throw new AppError(
        'VALIDATION_FAILED',
        'The setup is not valid',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    throw err;
  }
}

function assertAdmin(user: AuthUser) {
  if (!user.isAdmin) throw new AppError('FORBIDDEN', 'Only admins can change how the workspace is set up');
}

/** What the workspace has now, and what can be added: names, modules and presets. */
export async function setupOverview(user: AuthUser) {
  assertAdmin(user);
  const enabled = new Set(enabledModuleKeys());
  const last = await db('blueprint_applications').orderBy('id', 'desc').first();
  return {
    names: await getLabels('en'),
    currentPreset: (last?.blueprint_key as string | undefined) ?? null,
    modules: loadModules()
      .filter(({ manifest: m }) => m.status === 'available')
      .map(({ manifest: m }) => ({
        key: m.key,
        name: m.name,
        description: m.description,
        enabled: enabled.has(m.key),
      })),
    presets: listBlueprintKeys().map((key) => {
      const bp = loadBlueprint(key);
      return { key, name: bp.name, description: bp.description, ready: bp.status === 'ready' };
    }),
  };
}

/** Preview (dry run) or apply a drafted setup as the admin's own changes. */
export async function applySetupDraft(
  draft: SetupDraft,
  opts: { user: AuthUser; ctx: RequestContext; dryRun?: boolean },
): Promise<ApplyReport> {
  assertAdmin(opts.user);
  return asAppError(() =>
    applyBlueprint(
      db,
      parseBlueprint({ key: 'workspace-setup', name: 'Workspace setup', version: '1.0.0', ...draft }),
      { mode: 'add', dryRun: opts.dryRun, appliedBy: opts.user.id, ctx: opts.ctx },
    ),
  );
}

/** Preview (dry run) or add an installed preset next to what the workspace has. */
export async function addPreset(
  key: string,
  opts: { user: AuthUser; ctx: RequestContext; dryRun?: boolean },
): Promise<ApplyReport> {
  assertAdmin(opts.user);
  if (!listBlueprintKeys().includes(key)) throw new AppError('NOT_FOUND', `There is no preset "${key}"`);
  const bp = loadBlueprint(key);
  const last = await db('blueprint_applications').orderBy('id', 'desc').first();
  return asAppError(() =>
    applyBlueprint(db, bp, {
      mode: last && last.blueprint_key === key ? 'primary' : 'add',
      dryRun: opts.dryRun,
      appliedBy: opts.user.id,
      ctx: opts.ctx,
    }),
  );
}
