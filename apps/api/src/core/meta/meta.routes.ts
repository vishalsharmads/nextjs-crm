import { type AccessDto, type BootstrapDto, type LayoutDto } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { db } from '../../db/knex';
import { getMe } from '../auth/auth.routes';
import { getLabels } from '../labels/labels.service';
import { effectiveCompliance, getGroup, getRaw } from '../settings/settings.service';
import { fieldAccessMap, getDefinitions, fieldLevel } from '../custom-fields/definitions';
import { listPipelines } from '../pipelines/pipelines.repository';
import { enabledModuleKeys, moduleMenu, modulePanels, moduleShellPanels } from '../../modules/registry';
import { can } from '../rbac/access';
import { customizableEntities, moduleRecordDefs } from '../records/registry';
import { objectMenu } from '../objects/objects';
import { standardLevelsForBoot } from '../custom-fields/standard-visibility';

export async function accessFor(user: AuthUser): Promise<AccessDto> {
  const fields: AccessDto['fields'] = {};
  for (const entity of customizableEntities())
    fields[entity] = fieldAccessMap(await getDefinitions(entity), user);
  return {
    isAdmin: user.isAdmin,
    permissions: user.permissions,
    scopes: user.scopes,
    fields,
    mfaSetupRequired: !!user.mfaSetupRequired,
  };
}

export async function getLayouts(): Promise<LayoutDto[]> {
  const rows = await db('layouts').where({ is_default: true });
  return rows.map((r) => ({ entity: r.entity, context: r.context, ...(r.config as object) }));
}

export const metaRoutes = defineRoutes('/meta', ['meta']).add({
  method: 'get',
  path: '/bootstrap',
  permission: 'authenticated',
  summary: 'Everything the app shell needs after sign-in',
  handler: async ({ user }): Promise<BootstrapDto> => {
    const customFields = [];
    for (const entity of customizableEntities()) {
      for (const def of await getDefinitions(entity)) {
        const level = fieldLevel(def, user);
        if (level !== 'hidden') customFields.push({ ...def, level });
      }
    }
    const groups = await db('custom_field_groups').orderBy('sort_order');
    const labels = await getLabels('en');
    return {
      me: await getMe(user.id),
      access: await accessFor(user),
      labels,
      settings: {
        general: await getGroup('general'),
        features: await getGroup('features'),
        deals: await getGroup('deals'),
        contacts: await getGroup('contacts'),
        commerce: await getGroup('commerce'),
        ...(await effectiveCompliance().then((c) => ({
          session: { idleTimeoutMinutes: c.idleTimeoutMinutes, profile: c.profile },
          consentPurposes: c.consentPurposes
            .filter((p) => p.active)
            .map(({ key, label, marketing }) => ({ key, label, marketing })),
        }))),
      },
      customFields,
      standardFields: await standardLevelsForBoot(user),
      fieldGroups: groups.map((g) => ({
        entity: g.entity,
        key: g.key,
        label: g.label,
        sortOrder: g.sort_order,
      })),
      layouts: await getLayouts(),
      pipelines: await listPipelines(),
      modules: {
        enabled: enabledModuleKeys(),
        menu: [...moduleMenu(), ...(await objectMenu(labels))].filter((m) => can(user, m.permission)),
        panels: modulePanels()
          .filter((p) => can(user, p.permission))
          .map(({ moduleKey, key, entity, title, order }) => ({ moduleKey, key, entity, title, order })),
        shellPanels: moduleShellPanels()
          .filter((p) => can(user, p.permission))
          .map(({ moduleKey, key, title, icon }) => ({ moduleKey, key, title, icon })),
      },
      helpNotes: ((await getRaw('help_notes')) as Record<string, string> | undefined) ?? {},
      recordTypes: moduleRecordDefs()
        .filter((d) => d.meta && can(user, `${d.resource}.view`))
        .map((d) => d.meta!),
    };
  },
});
