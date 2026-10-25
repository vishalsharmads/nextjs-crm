import { contactSettingsSchema } from '@app/shared';
import type { Blueprint, BlueprintField } from './schema';

const DEFAULT_LIFECYCLE = contactSettingsSchema.parse({}).lifecycleStatuses;

/**
 * Static checks on a blueprint's `sample_data`: every reference points at something that exists
 * (records, stages, custom fields and their options, roles, modules), so a demo reset cannot fail
 * halfway. Returns problems as readable strings; empty means fine.
 * `moduleDeps` maps a module key to the modules it depends on (they are enabled with it).
 */
export function checkSampleData(bp: Blueprint, moduleDeps: Record<string, string[]> = {}): string[] {
  const data = bp.sample_data;
  if (!data) return [];
  const problems: string[] = [];
  const refs: Record<'organization' | 'contact' | 'deal' | 'lead', Set<string>> = {
    organization: new Set(),
    contact: new Set(),
    deal: new Set(),
    lead: new Set(),
  };
  const roles = new Set(['admin', ...bp.roles.map((r) => r.key)]);
  const fields = (entity: string) =>
    new Map<string, BlueprintField>(
      (bp.custom_fields[entity as keyof Blueprint['custom_fields']] ?? []).map((f) => [f.key, f]),
    );

  const record = (entity: keyof typeof refs, rows: Record<string, unknown>[]) => {
    const known = fields(entity);
    rows.forEach((row, i) => {
      const where = `${entity} ${typeof row.ref === 'string' ? `"${row.ref}"` : `#${i + 1}`}`;
      if (typeof row.ref === 'string') {
        if (refs[entity]!.has(row.ref)) problems.push(`${where}: duplicate ref`);
        refs[entity]!.add(row.ref);
      }
      if (typeof row.owner === 'string' && !roles.has(row.owner))
        problems.push(`${where}: unknown owner role "${row.owner}"`);
      for (const [key, value] of Object.entries((row.custom as Record<string, unknown>) ?? {})) {
        const def = known.get(key);
        if (!def) {
          problems.push(`${where}: custom field "${key}" is not defined for ${entity}`);
          continue;
        }
        const options = def.options?.map((o) => o.key);
        const values = Array.isArray(value) ? value : [value];
        if (options && (def.type === 'select' || def.type === 'multi_select'))
          for (const v of values)
            if (!options.includes(String(v)))
              problems.push(`${where}: "${String(v)}" is not an option of ${key}`);
      }
    });
  };

  record('organization', data.organizations);
  record('contact', data.contacts);
  record('lead', data.leads);
  record('deal', data.deals);

  const lifecycle =
    (bp.settings as { contacts?: { lifecycleStatuses?: string[] } }).contacts?.lifecycleStatuses ??
    DEFAULT_LIFECYCLE;
  for (const c of data.contacts) {
    if (typeof c.organization === 'string' && !refs.organization.has(c.organization))
      problems.push(`contact "${String(c.ref)}": unknown organization "${c.organization}"`);
    if (typeof c.lifecycle_status === 'string' && !lifecycle.includes(c.lifecycle_status))
      problems.push(
        `contact "${String(c.ref)}": lifecycle status "${c.lifecycle_status}" is not in settings.contacts.lifecycleStatuses`,
      );
  }

  const pipeline =
    bp.pipelines.find((p) => p.entity === 'deal' && p.is_default) ??
    bp.pipelines.find((p) => p.entity === 'deal');
  const stages = new Map((pipeline?.stages ?? []).map((s) => [s.key, s]));
  const lostReasons = (bp.settings as { deals?: { lostReasons?: string[] } }).deals?.lostReasons;
  for (const d of data.deals) {
    const where = `deal "${String(d.ref ?? d.title)}"`;
    if (!stages.has(String(d.stage))) problems.push(`${where}: unknown stage "${String(d.stage)}"`);
    if (typeof d.contact === 'string' && !refs.contact.has(d.contact))
      problems.push(`${where}: unknown contact "${d.contact}"`);
    if (typeof d.organization === 'string' && !refs.organization.has(d.organization))
      problems.push(`${where}: unknown organization "${d.organization}"`);
    if (
      stages.get(String(d.stage))?.is_lost &&
      lostReasons &&
      typeof d.lost_reason === 'string' &&
      !lostReasons.includes(d.lost_reason)
    )
      problems.push(`${where}: lost reason "${d.lost_reason}" is not in settings.deals.lostReasons`);
  }

  for (const [i, a] of data.activities.entries()) {
    const where = `activity #${i + 1}`;
    if (!['note', 'task', 'call', 'meeting'].includes(String(a.type ?? 'note')))
      problems.push(`${where}: unknown type "${String(a.type)}"`);
    if (a.type !== 'note' && a.type !== undefined && typeof a.subject !== 'string')
      problems.push(`${where}: needs a subject`);
    if ((a.type ?? 'note') === 'note' && typeof a.body !== 'string')
      problems.push(`${where}: a note needs a body`);
    if (typeof a.owner === 'string' && !roles.has(a.owner))
      problems.push(`${where}: unknown owner role "${a.owner}"`);
    if (typeof a.related === 'string') {
      const [type, ref] = a.related.split(':');
      if (!(refs as Record<string, Set<string> | undefined>)[type!]?.has(ref!))
        problems.push(`${where}: unknown related record "${a.related}"`);
    }
  }

  const enabled = new Set<string>();
  const enable = (key: string) => {
    if (enabled.has(key)) return;
    enabled.add(key);
    for (const dep of moduleDeps[key] ?? []) enable(dep);
  };
  bp.modules.forEach(enable);
  const results = new Set<string>();
  for (const [i, r] of data.requests.entries()) {
    const where = `request #${i + 1} (${r.method.toUpperCase()} ${r.path})`;
    const mod = /^\/m\/([a-z][a-z0-9-]*)\//.exec(r.path)?.[1];
    if (mod && !enabled.has(mod)) problems.push(`${where}: module "${mod}" is not enabled by this blueprint`);
    const text = JSON.stringify([r.path, r.body]);
    for (const [, type, arg] of text.matchAll(/\{\{([a-z_]+):([^}]+)\}\}/g)) {
      if (type === 'date' && !/^[+-]?\d+$/.test(arg!)) problems.push(`${where}: bad date "${arg}"`);
      else if (type === 'datetime' && !/^[+-]?\d+(@\d{1,2}(:\d{2})?)?$/.test(arg!))
        problems.push(`${where}: bad datetime "${arg}"`);
      else if (type === 'req' && !results.has(arg!))
        problems.push(`${where}: {{req:${arg}}} is not created by an earlier request`);
      else if (type === 'user' && !roles.has(arg!)) problems.push(`${where}: unknown role "${arg}"`);
      else if (type! in refs && !(refs as Record<string, Set<string>>)[type!]!.has(arg!))
        problems.push(`${where}: unknown ${type} "${arg}"`);
      else if (!['date', 'datetime', 'req', 'user', ...Object.keys(refs)].includes(type!))
        problems.push(`${where}: unknown placeholder type "${type}"`);
    }
    if (r.ref) {
      if (results.has(r.ref)) problems.push(`${where}: duplicate ref "${r.ref}"`);
      results.add(r.ref);
    }
  }
  return problems;
}
