import {
  FIELD_KEY_RE,
  VISIBILITY_RANK,
  visibilitySchema,
  type CustomFieldDef,
  type CustomizableEntity,
  type FieldType,
  type VisibilityLevel,
} from '@app/shared';
import { db, type Db } from '../../db/knex';
import type { AuthUser } from '../../http/context';

export const ENTITY_TABLE: Record<CustomizableEntity, string> = {
  contact: 'contacts',
  organization: 'organizations',
  lead: 'leads',
  deal: 'deals',
  activity: 'activities',
};

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => (v === null || v === undefined ? fallback : (v as T));

export function rowToDef(r: Row): CustomFieldDef {
  const config = json<{ options?: CustomFieldDef['options']; currency?: string; placeholder?: string }>(
    r.config,
    {},
  );
  return {
    uuid: r.uuid as string,
    entity: r.entity as CustomizableEntity,
    key: r.key as string,
    label: r.label as string,
    type: r.type as FieldType,
    group: (r.group_key as string | null) ?? null,
    options: config.options ?? [],
    currency: config.currency ?? null,
    placeholder: config.placeholder ?? null,
    helpText: (r.help_text as string | null) ?? null,
    required: !!r.required,
    defaultValue: r.default_value ?? null,
    validation: json(r.validation, {}),
    visibility: visibilitySchema.parse(json(r.visibility, {})),
    filterable: !!r.filterable,
    showInList: !!r.show_in_list,
    sortOrder: Number(r.sort_order ?? 0),
    active: !!r.active,
    sourceBlueprint: (r.source_blueprint as string | null) ?? null,
    customized: !!r.customized,
  };
}

/** Definitions cache, invalidated by a version counter bumped on every change. */
let version = 0;
const cache = new Map<string, { defs: CustomFieldDef[]; version: number; at: number }>();

export function bumpDefinitionsVersion() {
  version++;
  cache.clear();
}

export async function getDefinitions(
  entity: CustomizableEntity,
  opts: { includeArchived?: boolean; conn?: Db } = {},
) {
  const key = `${entity}:${opts.includeArchived ? 'all' : 'active'}`;
  const hit = cache.get(key);
  if (!opts.conn && hit && hit.version === version && Date.now() - hit.at < 5000) return hit.defs;
  const q = (opts.conn ?? db)('custom_field_definitions')
    .where({ entity })
    .orderBy([{ column: 'sort_order' }, { column: 'id' }]);
  if (!opts.includeArchived) q.where({ active: true });
  const defs = (await q).map(rowToDef);
  if (!opts.conn) cache.set(key, { defs, version, at: Date.now() });
  return defs;
}

export async function getDefinition(entity: CustomizableEntity, key: string, conn: Db = db) {
  if (!FIELD_KEY_RE.test(key)) return null;
  const row = await conn('custom_field_definitions').where({ entity, key }).first();
  return row ? rowToDef(row) : null;
}

/** Effective visibility of a field for a user: most permissive across roles; admins always write. */
export function fieldLevel(
  def: Pick<CustomFieldDef, 'visibility'>,
  user: Pick<AuthUser, 'isAdmin' | 'roleKeys'>,
): VisibilityLevel {
  if (user.isAdmin) return 'write';
  let best: VisibilityLevel | null = null;
  for (const role of user.roleKeys) {
    const lvl = def.visibility.roles[role];
    if (lvl && (!best || VISIBILITY_RANK[lvl] > VISIBILITY_RANK[best])) best = lvl;
  }
  return best ?? def.visibility.default;
}

export function fieldAccessMap(defs: CustomFieldDef[], user: Pick<AuthUser, 'isAdmin' | 'roleKeys'>) {
  return Object.fromEntries(defs.map((d) => [d.key, fieldLevel(d, user)])) as Record<string, VisibilityLevel>;
}
