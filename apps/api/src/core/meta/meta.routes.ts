import { CUSTOMIZABLE_ENTITIES, type AccessDto, type BootstrapDto, type LayoutDto } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { db } from '../../db/knex';
import { getMe } from '../auth/auth.routes';
import { getLabels } from '../labels/labels.service';
import { getGroup } from '../settings/settings.service';
import { fieldAccessMap, getDefinitions, fieldLevel } from '../custom-fields/definitions';
import { listPipelines } from '../pipelines/pipelines.repository';
import { enabledModuleKeys, moduleMenu } from '../../modules/registry';
import { can } from '../rbac/access';

export async function accessFor(user: AuthUser): Promise<AccessDto> {
  const fields: AccessDto['fields'] = {};
  for (const entity of CUSTOMIZABLE_ENTITIES)
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
    for (const entity of CUSTOMIZABLE_ENTITIES) {
      for (const def of await getDefinitions(entity)) {
        const level = fieldLevel(def, user);
        if (level !== 'hidden') customFields.push({ ...def, level });
      }
    }
    const groups = await db('custom_field_groups').orderBy('sort_order');
    return {
      me: await getMe(user.id),
      access: await accessFor(user),
      labels: await getLabels('en'),
      settings: {
        general: await getGroup('general'),
        features: await getGroup('features'),
        deals: await getGroup('deals'),
        contacts: await getGroup('contacts'),
        commerce: await getGroup('commerce'),
      },
      customFields,
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
        menu: moduleMenu().filter((m) => can(user, m.permission)),
      },
    };
  },
});
