import { z } from 'zod';
import {
  ENTITY_KEY_PATTERN,
  isCoreEntity,
  normalizePhone,
  toPatch,
  type RecordColumnKind,
  type RecordColumnMeta,
  type RecordTypeMeta,
} from '@app/shared';
import { serializeCustom } from './custom';
import {
  compact,
  customContext,
  dateField,
  numberField,
  ownerField,
  relationField,
  selectField,
  textField,
  timestampsFields,
} from './common';
import { iso, userIdFromRef, userRefs } from './hydrate';
import { AppError } from '../../lib/errors';
import type { AuthUser } from '../../http/context';
import type { Knex } from 'knex';
import type { Db } from '../../db/knex';
import { can } from '../rbac/access';
import { scopedQuery } from './service';
import { findRecordDef } from './registry';
import type { CoreFieldSpec, ResourceDef } from './types';
import { moduleTablePrefix } from './paths';

/** A core column of a module record type. Keys are camelCase in DTOs and inputs, snake_case in SQL. */
export interface RecordColumnSpec {
  key: string;
  label: string;
  kind: Exclude<RecordColumnKind, 'user'>;
  required?: boolean;
  /** Max length for text kinds (default 255; textarea 10 000). */
  max?: number;
  options?: { value: string; label: string }[];
  relation?: RecordColumnMeta['relation'];
  currency?: string;
  /** Included in search (text kinds only; must be in the table's FULLTEXT index). */
  searchable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
}

export interface RecordTypeSpec {
  moduleKey: string;
  /** Globally unique entity key, e.g. `property`. */
  entity: string;
  /** URL segment under `/m/<moduleKey>/`, e.g. `properties`. */
  route: string;
  /** Table name; must start with `m_<moduleKey>_` (hyphens as underscores). */
  table: string;
  /** Permission resource, e.g. `properties.properties` (actions: view, create, update, delete, assign, …). */
  resource: string;
  labels: { singular: string; plural: string };
  columns: RecordColumnSpec[];
  /** Column shown as the record's name (a text column). */
  titleColumn: string;
  defaultColumns?: string[];
  /** Default list sort over field keys (columns, `owner`, `created_at`, `updated_at`). */
  defaultSort?: string;
  /** Notify the new owner when a record is assigned (default true). */
  notifyOwner?: boolean;
}

const RELATION_TABLE = {
  contact: { table: 'contacts', title: 'full_name' },
  organization: { table: 'organizations', title: 'name' },
  deal: { table: 'deals', title: 'title' },
  lead: { table: 'leads', title: 'full_name' },
} as const;

/**
 * Table and title column of a relation target: a core entity, or an admin-defined object (whose
 * table is `m_custom_<key>` and title `name`). Resolved by key so an object can link to an object
 * that registers later.
 */
function relationTarget(key: string): { table: string; title: string } {
  if (isCoreEntity(key) && key in RELATION_TABLE) return RELATION_TABLE[key as keyof typeof RELATION_TABLE];
  return { table: `m_custom_${key}`, title: 'name' };
}

export const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const COLUMN_KEY = /^[a-z][a-zA-Z0-9]{0,40}$/;
const TEXT_KINDS = new Set(['text', 'textarea', 'email', 'phone', 'url']);

function inputSchema(c: RecordColumnSpec): z.ZodType {
  let s: z.ZodType;
  switch (c.kind) {
    case 'text':
    case 'textarea':
      s = z
        .string()
        .trim()
        .max(c.max ?? (c.kind === 'textarea' ? 10_000 : 255));
      if (c.required) s = (s as z.ZodString).min(1);
      break;
    case 'email':
      s = z.email().max(255);
      break;
    case 'phone':
      s = z.string().trim().max(40);
      break;
    case 'url':
      s = z.url().max(500);
      break;
    case 'number':
      s = z.number().finite();
      break;
    case 'money':
      s = z.number().finite().min(0);
      break;
    case 'date':
      s = z.iso.date();
      break;
    case 'datetime':
      s = z.iso.datetime({ offset: true });
      break;
    case 'boolean':
      s = z.boolean();
      break;
    case 'select': {
      const values = (c.options ?? []).map((o) => o.value);
      s = z.enum(values as [string, ...string[]]);
      break;
    }
    case 'relation':
      s = z.uuid();
      break;
  }
  // Forms send '' for an empty input and 'true'/'false' from a yes/no select.
  const blank = (v: unknown) => (v === '' && !c.required ? null : v);
  const bool = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v);
  return z.preprocess(
    (v) => (c.kind === 'boolean' ? bool(blank(v)) : blank(v)),
    c.required ? s : s.nullish(),
  );
}

function fieldSpec(table: string, c: RecordColumnSpec): CoreFieldSpec {
  const col = `${table}.${snake(c.key)}`;
  let spec: CoreFieldSpec;
  if (c.kind === 'relation') {
    const rel = relationTarget(c.relation!);
    spec = relationField(table, `${snake(c.key)}_id`, rel.table, rel.title);
  } else if (c.kind === 'number' || c.kind === 'money') spec = numberField(col);
  else if (c.kind === 'date' || c.kind === 'datetime') spec = dateField(col, c.kind);
  else if (c.kind === 'select' || c.kind === 'boolean') spec = selectField(col);
  else spec = textField(col);
  return { ...spec, sortable: c.sortable ?? spec.sortable, filterable: c.filterable ?? spec.filterable };
}

/** Core records of a relation target the user may view (permission and scope), with their names. */
async function visibleTargets(
  relation: NonNullable<RecordColumnMeta['relation']>,
  user: AuthUser,
  conn: Db,
  where: (qb: Knex.QueryBuilder, table: string) => void,
): Promise<{ id: number; uuid: string; name: string }[]> {
  // An archived object, or a disabled module's type, links to nothing.
  const def = findRecordDef(relation);
  if (!def || !can(user, `${def.resource}.view`)) return [];
  const { qb } = await scopedQuery(def, user, conn);
  where(qb, def.table);
  return (await qb.select(
    `${def.table}.id`,
    `${def.table}.uuid`,
    `${def.table}.${relationTarget(relation).title} as name`,
  )) as { id: number; uuid: string; name: string }[];
}

function validateSpec(spec: RecordTypeSpec) {
  if (!ENTITY_KEY_PATTERN.test(spec.entity) || isCoreEntity(spec.entity))
    throw new Error(`Record type key "${spec.entity}" is invalid or reserved`);
  if (!spec.table.startsWith(moduleTablePrefix(spec.moduleKey)))
    throw new Error(`Table of "${spec.entity}" must be named ${moduleTablePrefix(spec.moduleKey)}*`);
  if (!spec.resource.startsWith(`${spec.moduleKey}.`))
    throw new Error(`Resource of "${spec.entity}" must start with "${spec.moduleKey}."`);
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(spec.route)) throw new Error(`Invalid route "${spec.route}"`);
  const keys = new Set<string>();
  for (const c of spec.columns) {
    if (!COLUMN_KEY.test(c.key) || keys.has(c.key) || ['owner', 'custom', 'uuid'].includes(c.key))
      throw new Error(`Invalid or duplicate column "${c.key}" on "${spec.entity}"`);
    if (c.kind === 'relation' && !c.relation) throw new Error(`Relation column "${c.key}" needs a target`);
    if (c.kind === 'select' && !c.options?.length) throw new Error(`Select column "${c.key}" needs options`);
    keys.add(c.key);
  }
  const title = spec.columns.find((c) => c.key === spec.titleColumn);
  if (!title || !TEXT_KINDS.has(title.kind)) throw new Error(`Title column of "${spec.entity}" must be text`);
}

/**
 * Build the records-engine definition of a module record type. The table must have the standard
 * columns (id, uuid, owner_id, custom, created_by, updated_by, created_at, updated_at, deleted_at),
 * one column per spec column (relations as `<key>_id`; nullable unless the column is required),
 * and a FULLTEXT index over the searchable text columns in spec order. `module:new` generates such a migration.
 */
export function defineRecordType(spec: RecordTypeSpec): ResourceDef {
  validateSpec(spec);
  const { table, columns } = spec;
  const searchable = columns.filter((c) => c.searchable && TEXT_KINDS.has(c.kind));
  const shape: Record<string, z.ZodType> = { ownerUuid: z.union([z.uuid(), z.literal('@me')]).nullish() };
  for (const c of columns) shape[c.kind === 'relation' ? `${c.key}Uuid` : c.key] = inputSchema(c);
  const createSchema = z.object(shape);

  const fields: Record<string, CoreFieldSpec> = { owner: ownerField(table), ...timestampsFields(table) };
  for (const c of columns) fields[c.key] = fieldSpec(table, c);

  const meta: RecordTypeMeta = {
    entity: spec.entity,
    moduleKey: spec.moduleKey,
    route: spec.route,
    resource: spec.resource,
    titleColumn: spec.titleColumn,
    columns: columns.map((c) => ({
      key: c.key,
      label: c.label,
      kind: c.kind,
      required: !!c.required,
      sortable: fields[c.key]!.sortable ?? false,
      filterable: fields[c.key]!.filterable ?? false,
      ...(c.options ? { options: c.options } : {}),
      ...(c.relation ? { relation: c.relation } : {}),
      ...(c.currency ? { currency: c.currency } : {}),
    })),
    defaultColumns: spec.defaultColumns ?? [spec.titleColumn, 'owner', 'updated_at'],
    defaultSort: spec.defaultSort ?? '-created_at',
    searchable: searchable.length > 0,
  };

  return {
    entity: spec.entity,
    route: spec.route,
    moduleKey: spec.moduleKey,
    labels: spec.labels,
    meta,
    table,
    resource: spec.resource,
    ownerColumns: [`${table}.owner_id`],
    fulltext: searchable.map((c) => `${table}.${snake(c.key)}`),
    likeColumns: searchable.map((c) => `${table}.${snake(c.key)}`),
    notifyColumn: spec.notifyOwner === false ? undefined : 'owner_id',
    defaultSort: meta.defaultSort,
    fields,
    createSchema,
    patchSchema: toPatch(createSchema),
    ioColumns: columns
      .filter((c) => c.kind !== 'relation')
      .map((c) => ({
        key: c.key,
        header: c.label,
        get: (d: Record<string, unknown>) => d[c.key],
        importable: true,
        required: !!c.required,
        kind: c.kind,
      })),
    async toRow(input, { user, conn, existing }) {
      const row: Record<string, unknown> = {
        owner_id: await userIdFromRef(input.ownerUuid as string | null | undefined, user, conn),
      };
      for (const c of columns) {
        if (c.kind === 'relation') {
          const field = `${c.key}Uuid`;
          const ref = input[field] as string | null | undefined;
          if (ref === undefined || ref === null) {
            if (ref === null) row[`${snake(c.key)}_id`] = null;
            continue;
          }
          // Link only to records the user may see, so names cannot be probed or leaked.
          const [hit] = await visibleTargets(c.relation!, user, conn, (qb, t) => qb.where(`${t}.uuid`, ref));
          if (!hit)
            throw new AppError('VALIDATION_FAILED', 'Not found', [{ path: field, message: 'Not found' }]);
          row[`${snake(c.key)}_id`] = hit.id;
          continue;
        }
        let v = input[c.key];
        if (v !== undefined && v !== null && c.kind === 'phone') v = normalizePhone(String(v)) || v;
        if (v !== undefined && v !== null && c.kind === 'datetime') v = new Date(String(v));
        if (v !== undefined && c.kind === 'money' && v !== null) v = Math.round(Number(v) * 100);
        row[snake(c.key)] = v;
      }
      // On create, an empty value means "not set": leave it out so a column default applies.
      const kept = existing
        ? row
        : Object.fromEntries(Object.entries(row).filter(([k, v]) => v !== null || k === 'owner_id'));
      return compact(kept);
    },
    async toDtos(rows, { user, conn }) {
      const [owners, cf] = await Promise.all([
        userRefs(
          rows.map((r) => r.owner_id as number | null),
          conn,
        ),
        customContext(spec.entity, user),
      ]);
      const related = new Map<string, Map<number, { uuid: string; name: string }>>();
      for (const c of columns.filter((x) => x.kind === 'relation')) {
        const ids = [...new Set(rows.map((r) => r[`${snake(c.key)}_id`]).filter((x) => x != null))];
        // Linked records outside the reader's scope show as empty.
        const found = ids.length
          ? await visibleTargets(c.relation!, user, conn, (qb, t) => qb.whereIn(`${t}.id`, ids as number[]))
          : [];
        related.set(c.key, new Map(found.map((f) => [f.id as number, { uuid: f.uuid, name: f.name }])));
      }
      return rows.map((r) => {
        const dto: Record<string, unknown> = {
          uuid: r.uuid,
          owner: owners.get(r.owner_id as number) ?? null,
        };
        for (const c of columns) {
          if (c.kind === 'relation') {
            dto[c.key] = related.get(c.key)!.get(r[`${snake(c.key)}_id`] as number) ?? null;
            continue;
          }
          const v = r[snake(c.key)];
          dto[c.key] =
            v === null || v === undefined
              ? null
              : c.kind === 'money'
                ? Number(v) / 100
                : c.kind === 'number'
                  ? Number(v)
                  : c.kind === 'boolean'
                    ? !!v
                    : c.kind === 'datetime'
                      ? iso(v)
                      : v;
        }
        dto.custom = serializeCustom(r.custom, cf.defs, cf.levels);
        dto.createdAt = iso(r.created_at);
        dto.updatedAt = iso(r.updated_at);
        dto.deletedAt = iso(r.deleted_at);
        return dto;
      });
    },
  };
}
