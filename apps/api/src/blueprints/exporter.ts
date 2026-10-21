import type { Knex } from 'knex';
import { blueprintSchema, type BlueprintInput } from '@app/blueprints';
import { CUSTOMIZABLE_ENTITIES, SETTINGS_GROUPS } from '@app/shared';
import { rowToDef } from '../core/custom-fields/definitions';

/** Serialize the current configuration (no records) as a blueprint, so a configured install can become a preset. */
export async function exportBlueprint(knex: Knex, opts: { key?: string; version?: string } = {}) {
  const install = (await knex('settings').where({ key: 'install' }).first())?.value as
    { blueprint?: string } | undefined;
  const last = await knex('blueprint_applications').orderBy('id', 'desc').first();
  const key = opts.key ?? `${install?.blueprint ?? 'custom'}-export`;

  const settings: Record<string, unknown> = {};
  for (const group of Object.keys(SETTINGS_GROUPS)) {
    const row = await knex('settings').where({ key: group }).first();
    if (row) settings[group] = row.value;
  }

  const labels = await knex('labels').where({ locale: 'en' });
  const modules = await knex('module_states').where({ enabled: true }).pluck('module_key');

  const custom_field_groups: Record<string, unknown[]> = {};
  const custom_fields: Record<string, unknown[]> = {};
  for (const entity of CUSTOMIZABLE_ENTITIES) {
    const groups = await knex('custom_field_groups').where({ entity }).orderBy('sort_order');
    if (groups.length)
      custom_field_groups[entity] = groups.map((g) => ({
        key: g.key,
        label: g.label,
        ...(g.visibility ? { visibility: g.visibility } : {}),
      }));
    const defs = (
      await knex('custom_field_definitions').where({ entity, active: true }).orderBy('sort_order')
    ).map(rowToDef);
    if (defs.length) {
      custom_fields[entity] = defs.map((d) => ({
        key: d.key,
        label: d.label,
        type: d.type,
        ...(d.group ? { group: d.group } : {}),
        ...(d.options.length ? { options: d.options } : {}),
        ...(d.currency ? { currency: d.currency } : {}),
        ...(d.helpText ? { help_text: d.helpText } : {}),
        required: d.required,
        ...(d.defaultValue !== null ? { default: d.defaultValue } : {}),
        ...(Object.keys(d.validation).length ? { validation: d.validation } : {}),
        visibility: d.visibility,
        filterable: d.filterable,
        show_in_list: d.showInList,
      }));
    }
  }

  const pipelines = [];
  for (const p of await knex('pipelines').where({ active: true }).orderBy('sort_order')) {
    const stages = await knex('pipeline_stages')
      .where({ pipeline_id: p.id, active: true })
      .orderBy('sort_order');
    pipelines.push({
      key: (p.source_key as string | null)?.replace(/^pipeline\./, '') ?? slug(p.name),
      name: p.name,
      entity: p.entity,
      is_default: !!p.is_default,
      stages: stages.map((s) => ({
        key: s.key,
        name: s.name,
        probability: s.probability,
        ...(s.color ? { color: s.color } : {}),
        is_won: !!s.is_won,
        is_lost: !!s.is_lost,
        ...(s.rotting_days ? { rotting_days: s.rotting_days } : {}),
      })),
    });
  }

  const roles = [];
  for (const r of await knex('roles').whereNot({ key: 'admin' }).orderBy('id')) {
    const permissions = await knex('role_permissions').where({ role_id: r.id }).pluck('pattern');
    const scopes = Object.fromEntries(
      (await knex('role_scopes').where({ role_id: r.id })).map((s) => [s.resource, s.scope]),
    );
    roles.push({ key: r.key, name: r.name, description: r.description, permissions, scopes });
  }

  const layouts = (await knex('layouts').where({ name: 'default' })).map((l) => ({
    entity: l.entity,
    context: l.context,
    ...((l.config as { sections?: unknown; columns?: unknown }).sections
      ? { sections: l.config.sections }
      : {}),
    ...((l.config as { columns?: unknown }).columns ? { columns: l.config.columns } : {}),
  }));

  const dash = await knex('dashboards').whereNull('owner_id').where({ is_default: true }).first();
  const templates = (await knex('templates')).map((t) => ({
    key: t.key,
    channel: t.channel,
    locale: t.locale,
    name: t.name,
    subject: t.subject,
    body: t.body,
  }));

  const bp: BlueprintInput = {
    key,
    name: opts.key ? opts.key : `Export of ${install?.blueprint ?? 'instance'}`,
    version: opts.version ?? bumpMinor(last?.version ?? '0.0.0'),
    description: `Exported on ${new Date().toISOString().slice(0, 10)}`,
    settings,
    vocabulary: Object.fromEntries(
      labels.map((l) => [l.entity_key, { singular: l.singular, plural: l.plural }]),
    ),
    modules,
    custom_field_groups,
    custom_fields,
    pipelines,
    roles,
    layouts,
    ...(dash ? { dashboard: { name: dash.name, widgets: dash.widgets } } : {}),
    templates,
  } as BlueprintInput;
  // Validate so an export is always re-importable.
  return blueprintSchema.parse(bp);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64) || 'pipeline';

function bumpMinor(v: string) {
  const [a = 0, b = 0] = v.split('.').map(Number);
  return `${a}.${b + 1}.0`;
}
