import {
  CUSTOM_OBJECTS_KEY,
  type CustomObjectDto,
  type ModuleMenuItemDto,
  type ObjectLinkTarget,
  type PermissionDef,
} from '@app/shared';
import { db, type Db } from '../../db/knex';
import { defineRecordType } from '../records/record-type';
import { moduleTablePrefix } from '../records/paths';
import { allModuleRecordDefs, registerRecordType, setRecordTypeArchived } from '../records/registry';
import { registerModulePermissions, syncPermissions } from '../rbac/catalog';
import { iso } from '../records/hydrate';
import type { PrivacyHandler } from '../privacy/handlers';
import type { ResourceDef } from '../records/types';

/** A row of `custom_objects`. */
export interface ObjectRow {
  id: number;
  uuid: string;
  entity: string;
  route: string;
  singular: string;
  plural: string;
  icon: string;
  description: string | null;
  links: ObjectLinkTarget[] | string;
  sort_order: number;
  archived_at: Date | null;
  source_blueprint: string | null;
  customized: number | boolean;
  created_at: Date;
}

const ACTIONS = ['view', 'create', 'update', 'delete', 'assign', 'bulk', 'export', 'import'] as const;

export const objectTable = (entity: string) => `${moduleTablePrefix(CUSTOM_OBJECTS_KEY)}${entity}`;
export const objectResource = (entity: string) => `${CUSTOM_OBJECTS_KEY}.${entity}`;

export const linksOf = (row: Pick<ObjectRow, 'links'>): ObjectLinkTarget[] =>
  typeof row.links === 'string' ? (JSON.parse(row.links) as ObjectLinkTarget[]) : row.links;

export function toObjectDto(row: ObjectRow): CustomObjectDto {
  return {
    uuid: row.uuid,
    key: row.entity,
    route: row.route,
    singular: row.singular,
    plural: row.plural,
    icon: row.icon,
    description: row.description,
    links: linksOf(row),
    archived: !!row.archived_at,
    fromBlueprint: row.customized ? null : row.source_blueprint,
    createdAt: iso(row.created_at)!,
  };
}

/** The records-engine definition of an object: a required name plus one column per link. */
export function objectDef(row: ObjectRow): ResourceDef {
  return defineRecordType({
    moduleKey: CUSTOM_OBJECTS_KEY,
    entity: row.entity,
    route: row.route,
    table: objectTable(row.entity),
    resource: objectResource(row.entity),
    labels: { singular: row.singular, plural: row.plural },
    columns: [
      {
        key: 'name',
        label: 'Name',
        kind: 'text',
        max: 200,
        required: true,
        searchable: true,
        sortable: true,
        filterable: true,
      },
      ...linksOf(row).map((target) => ({
        key: target,
        label: target,
        kind: 'relation' as const,
        relation: target,
        filterable: true,
      })),
    ],
    titleColumn: 'name',
    defaultColumns: ['name', ...linksOf(row), 'owner', 'updated_at'],
  });
}

/**
 * Create the object's table, and any link columns added since. DDL commits implicitly in MySQL,
 * so this runs outside business transactions, and it is idempotent.
 */
export async function ensureObjectTable(row: Pick<ObjectRow, 'entity' | 'links'>, conn: Db = db) {
  const table = objectTable(row.entity);
  if (!(await conn.schema.hasTable(table))) {
    await conn.schema.createTable(table, (t) => {
      t.bigIncrements('id').unsigned().primary();
      t.specificType('uuid', 'CHAR(36)').notNullable().unique(`uq_${table}_uuid`);
      t.string('name', 200).notNullable();
      t.bigInteger('owner_id').unsigned().nullable();
      t.json('custom').notNullable();
      t.bigInteger('created_by').unsigned().nullable();
      t.bigInteger('updated_by').unsigned().nullable();
      t.datetime('created_at').notNullable().defaultTo(conn.fn.now());
      t.datetime('updated_at')
        .notNullable()
        .defaultTo(conn.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
      t.datetime('deleted_at').nullable();
      for (const col of ['owner_id', 'created_by', 'updated_by'])
        t.foreign(col, `fk_${table}_${col.slice(0, 5)}`)
          .references('id')
          .inTable('users')
          .onDelete('SET NULL');
      t.index(['owner_id'], `ix_${table}_owner`);
      t.index(['deleted_at', 'created_at'], `ix_${table}_deleted`);
    });
    // Must list exactly the searchable columns of the record type (`name`).
    await conn.raw(`ALTER TABLE ?? ADD FULLTEXT INDEX ?? (name)`, [table, `ft_${table}`]);
  }
  for (const target of linksOf(row)) {
    const col = `${target}_id`;
    if (await conn.schema.hasColumn(table, col)) continue;
    const parent = { contact: 'contacts', organization: 'organizations', deal: 'deals', lead: 'leads' }[
      target
    ];
    await conn.schema.alterTable(table, (t) => {
      t.bigInteger(col).unsigned().nullable();
      t.foreign(col, `fk_${table}_${target.slice(0, 4)}`)
        .references('id')
        .inTable(parent)
        .onDelete('SET NULL');
    });
  }
}

/** Register (or re-register after an edit) one object's record type and archive state. */
export function registerObject(row: ObjectRow) {
  registerRecordType(objectDef(row), { replace: true });
  setRecordTypeArchived(row.entity, !!row.archived_at);
}

function objectPermissions(rows: ObjectRow[]): PermissionDef[] {
  return rows.flatMap((r) =>
    ACTIONS.map((a) => ({ key: `${objectResource(r.entity)}.${a}`, description: `${a} ${r.plural}` })),
  );
}

/**
 * Load every object into the records registry and the permission catalog. Runs at boot and
 * after each admin change. Archived objects keep their permissions so role grants survive.
 */
export async function loadCustomObjects(conn: Db = db) {
  if (!(await conn.schema.hasTable('custom_objects'))) return;
  const rows = (await conn('custom_objects').orderBy('sort_order').orderBy('id')) as ObjectRow[];
  for (const row of rows) {
    await ensureObjectTable(row, conn);
    registerObject(row);
  }
  registerModulePermissions(CUSTOM_OBJECTS_KEY, objectPermissions(rows));
  await syncPermissions(conn);
}

/** Navigation entries of the objects the user may view (labels from vocabulary). */
export async function objectMenu(
  labels: Record<string, { plural: string } | undefined>,
  conn: Db = db,
): Promise<ModuleMenuItemDto[]> {
  if (!(await conn.schema.hasTable('custom_objects'))) return [];
  const rows = (await conn('custom_objects')
    .whereNull('archived_at')
    .orderBy('sort_order')
    .orderBy('id')) as ObjectRow[];
  return rows.map((r, i) => ({
    moduleKey: CUSTOM_OBJECTS_KEY,
    key: r.entity,
    label: labels[r.entity]?.plural ?? r.plural,
    path: `/o/${r.route}`,
    icon: r.icon,
    permission: `${objectResource(r.entity)}.view`,
    order: 40 + i,
  }));
}

/**
 * Data subject handlers for objects that link to contacts or leads: an access export lists the
 * linked records, and erasure (either mode) removes the link. The records belong to the
 * workspace, not to the person, so they are kept.
 */
export function objectPrivacyHandlers(): PrivacyHandler[] {
  return allModuleRecordDefs()
    .filter((d) => d.moduleKey === CUSTOM_OBJECTS_KEY)
    .flatMap((def) => {
      const links = (def.meta?.columns ?? [])
        .map((c) => c.relation)
        .filter((r): r is 'contact' | 'lead' => r === 'contact' || r === 'lead');
      if (!links.length) return [];
      const handler: PrivacyHandler = {
        key: def.resource,
        tables: [def.table],
        viewPermission: `${def.resource}.view`,
        async export(subject, conn) {
          if (!links.includes(subject.entity as 'contact' | 'lead')) return {};
          const rows = await conn(def.table)
            .where(`${subject.entity}_id`, subject.id)
            .select('uuid', 'name', 'created_at', 'updated_at', 'deleted_at');
          return { [def.entity]: rows };
        },
        async erase(subject, trx) {
          if (!links.includes(subject.entity as 'contact' | 'lead')) return {};
          const n = await trx(def.table)
            .where(`${subject.entity}_id`, subject.id)
            .update({ [`${subject.entity}_id`]: null });
          return { cleared: { [def.entity]: n } };
        },
      };
      return [handler];
    });
}
