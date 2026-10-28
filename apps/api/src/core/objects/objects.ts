import { createHash } from 'node:crypto';
import {
  CUSTOM_OBJECTS_KEY,
  LABEL_ENTITY_KEYS,
  isCoreEntity,
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
import { maskEncrypted } from '../records/custom';
import { logger } from '../../lib/logger';

/**
 * Entity names already used by audit rows, events and modules. An object with one of these keys
 * would mix its timeline, webhooks and automations with the other entity's.
 */
const RESERVED_KEYS = new Set([
  'access_log',
  'activity',
  'api_key',
  'asset',
  'assistant',
  'audit_log',
  'automation',
  'blueprint',
  'booking',
  'branding',
  'case',
  'contract',
  'custom_field',
  'custom_field_group',
  'custom_object',
  'dashboard',
  'document',
  'document_request',
  'email',
  'file',
  'form',
  'import',
  'invoice',
  'labels',
  'layout',
  'mail_account',
  'module',
  'note',
  'notification',
  'payment',
  'permission',
  'personal_access_token',
  'portal_account',
  'privacy_request',
  'product',
  'quote',
  'quota',
  'report',
  'retention',
  'role',
  'saved_view',
  'security',
  'session',
  'settings',
  'stock',
  'task',
  'template',
  'ticket',
  'token',
  'web_form',
  'webhook',
]);

/**
 * Why `key` cannot name an object, or null when it can. Shared by Settings → Objects, blueprints
 * and boot, so no path can register an object over a core entity, module type or reserved name.
 */
export async function objectKeyProblem(
  key: string,
  conn: Db = db,
  opts: { allowExistingObject?: boolean } = {},
): Promise<string | null> {
  if (isCoreEntity(key) || (LABEL_ENTITY_KEYS as readonly string[]).includes(key) || RESERVED_KEYS.has(key))
    return `"${key}" is reserved`;
  if (allModuleRecordDefs().some((d) => d.entity === key && d.moduleKey !== CUSTOM_OBJECTS_KEY))
    return `"${key}" is used by a module`;
  const { loadModules } = await import('../../modules/registry');
  if (loadModules().some((m) => m.manifest.key.replace(/-/g, '_') === key))
    return `"${key}" is a module name`;
  if (!opts.allowExistingObject && (await conn('custom_objects').where({ entity: key }).first()))
    return `"${key}" is already an object`;
  return null;
}

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
        // Column keys are camelCase: `service_visit` → `serviceVisit` (stored as `service_visit_id`).
        key: target.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
        label: target,
        kind: 'relation' as const,
        relation: target as string,
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
export async function ensureObjectTable(
  row: Pick<ObjectRow, 'entity' | 'links'>,
  conn: Db = db,
  opts: { links?: boolean } = {},
) {
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
  }
  // Checked on every pass, so a crash between CREATE and ALTER is repaired on the next load.
  const [indexes] = (await conn.raw('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, `ft_${table}`])) as [
    unknown[],
  ];
  if (!indexes.length)
    // Must list exactly the searchable columns of the record type (`name`).
    await conn.raw(`ALTER TABLE ?? ADD FULLTEXT INDEX ?? (name)`, [table, `ft_${table}`]);
  if (opts.links !== false) await ensureObjectLinks(row, conn);
}

const CORE_TABLES: Record<string, string> = {
  contact: 'contacts',
  organization: 'organizations',
  deal: 'deals',
  lead: 'leads',
};

/** Why the links of an object are not valid, or null: core targets or other live objects only. */
export async function linkProblem(links: string[], conn: Db = db): Promise<string | null> {
  for (const target of links) {
    if (CORE_TABLES[target]) continue;
    const obj = await conn('custom_objects').where({ entity: target }).whereNull('archived_at').first('id');
    if (!obj) return `"${target}" is not a record type you can link to`;
  }
  return null;
}

/** One nullable column per link, `<target>_id`, with a foreign key to the target's table. */
export async function ensureObjectLinks(row: Pick<ObjectRow, 'entity' | 'links'>, conn: Db = db) {
  const table = objectTable(row.entity);
  for (const target of linksOf(row)) {
    const col = `${target}_id`;
    if (await conn.schema.hasColumn(table, col)) continue;
    const parent = CORE_TABLES[target] ?? objectTable(target);
    if (!(await conn.schema.hasTable(parent))) continue;
    // Core targets keep their short names; object keys are hashed to stay within 64 characters.
    const fk = CORE_TABLES[target]
      ? `fk_${table}_${target.slice(0, 4)}`
      : `fk_${table}_${createHash('sha1').update(target).digest('hex').slice(0, 8)}`;
    await conn.schema.alterTable(table, (t) => {
      t.bigInteger(col).unsigned().nullable();
      t.foreign(col, fk).references('id').inTable(parent).onDelete('SET NULL');
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
  // Tables first, then links, so an object can link to one created after it.
  for (const row of rows) await ensureObjectTable(row, conn, { links: false }).catch(() => undefined);
  for (const row of rows) {
    // One bad object (a key a newer module now uses, a failed DDL) must not stop the app.
    try {
      const problem = await objectKeyProblem(row.entity, conn, { allowExistingObject: true });
      if (problem) throw new Error(problem);
      await ensureObjectTable(row, conn);
      registerObject(row);
    } catch (err) {
      logger.error({ err, object: row.entity }, 'Object could not be loaded');
    }
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
            .select('uuid', 'name', 'custom', 'created_at', 'updated_at', 'deleted_at');
          return { [def.entity]: rows.map((r) => ({ ...r, custom: maskEncrypted(r.custom) })) };
        },
        async erase(subject, trx) {
          if (!links.includes(subject.entity as 'contact' | 'lead')) return {};
          const n = await trx(def.table)
            .where(`${subject.entity}_id`, subject.id)
            .update({ [`${subject.entity}_id`]: null });
          return {
            cleared: { [def.entity]: n },
            retained: n
              ? [
                  {
                    area: def.entity,
                    reason: 'Records belong to the workspace; only the link to the person was removed',
                  },
                ]
              : undefined,
          };
        },
      };
      return [handler];
    });
}
