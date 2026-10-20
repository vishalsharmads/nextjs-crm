import {
  FIELD_KEY_RE,
  FILTERABLE_TYPES,
  generatedColumnName,
  type CustomFieldDef,
  type CustomizableEntity,
  type FieldType,
} from '@app/shared';
import { db } from '../../db/knex';
import { logger } from '../../lib/logger';
import { ENTITY_TABLE, getDefinitions, bumpDefinitionsVersion } from './definitions';

/** Max indexed custom fields per table (MySQL allows 64 indexes per table in total). */
export const MAX_INDEXED_FIELDS = 40;

const RETURNING: Partial<Record<FieldType, string>> = {
  text: 'CHAR(255)',
  url: 'CHAR(255)',
  email: 'CHAR(255)',
  phone: 'CHAR(32)',
  select: 'CHAR(64)',
  user: 'CHAR(36)',
  number: 'SIGNED',
  decimal: 'DECIMAL(20,4)',
  currency: 'DECIMAL(20,4)',
  date: 'DATE',
  // Datetimes are stored normalized as ISO-8601 UTC strings, which sort correctly as text.
  datetime: 'CHAR(30)',
  boolean: 'UNSIGNED',
};

const COLUMN_TYPE: Partial<Record<FieldType, string>> = {
  text: 'VARCHAR(255)',
  url: 'VARCHAR(255)',
  email: 'VARCHAR(255)',
  phone: 'VARCHAR(32)',
  select: 'VARCHAR(64)',
  user: 'CHAR(36)',
  number: 'BIGINT',
  decimal: 'DECIMAL(20,4)',
  currency: 'DECIMAL(20,4)',
  date: 'DATE',
  datetime: 'CHAR(30)',
  boolean: 'TINYINT UNSIGNED',
};

function assertSafe(table: string, key: string) {
  if (!Object.values(ENTITY_TABLE).includes(table)) throw new Error(`Unknown table ${table}`);
  if (!FIELD_KEY_RE.test(key)) throw new Error(`Unsafe field key ${key}`);
}

async function existingIndexes(table: string): Promise<Set<string>> {
  const [rows] = (await db.raw(`SHOW INDEX FROM \`${table}\``)) as [{ Key_name: string }[]];
  return new Set(rows.map((r) => r.Key_name));
}

async function existingColumns(table: string): Promise<Set<string>> {
  const rows = await db('information_schema.columns')
    .where({ table_schema: db.raw('DATABASE()'), table_name: table })
    .select('column_name as c');
  return new Set(rows.map((r) => (r as { c: string }).c));
}

let running: Promise<unknown> = Promise.resolve();

/**
 * Reconcile generated columns + indexes with definitions. Idempotent and safe to re-run.
 * Runs outside any transaction: MySQL DDL commits implicitly. Serialized with GET_LOCK.
 */
export function ensureCustomFieldIndexes(entity?: CustomizableEntity): Promise<string[]> {
  const job = running.then(() => reconcile(entity));
  running = job.catch(() => undefined);
  return job;
}

async function reconcile(only?: CustomizableEntity): Promise<string[]> {
  const changes: string[] = [];
  const conn = await db.client.acquireConnection();
  try {
    const lock = await db.raw('SELECT GET_LOCK(?, 30) AS l', ['cf_ddl']).connection(conn);
    if ((lock[0] as { l: number }[])[0]?.l !== 1)
      throw new Error('Could not acquire the custom field DDL lock');
    try {
      const entities = (only ? [only] : Object.keys(ENTITY_TABLE)) as CustomizableEntity[];
      for (const entity of entities) {
        const table = ENTITY_TABLE[entity];
        const defs = (await getDefinitions(entity, { includeArchived: true })).filter(
          (d) => d.active && d.filterable && FILTERABLE_TYPES.includes(d.type),
        );
        const cols = await existingColumns(table);
        const idx = await existingIndexes(table);
        let indexed = [...idx].filter((n) => n.startsWith('idx_cf_')).length;
        for (const def of defs) {
          changes.push(...(await ensureOne(table, def, cols, idx, () => indexed++ < MAX_INDEXED_FIELDS)));
        }
      }
    } finally {
      await db.raw('SELECT RELEASE_LOCK(?)', ['cf_ddl']).connection(conn);
    }
  } finally {
    await db.client.releaseConnection(conn);
  }
  if (changes.length) {
    bumpDefinitionsVersion();
    logger.info({ changes }, 'Custom field indexes reconciled');
  }
  return changes;
}

async function ensureOne(
  table: string,
  def: CustomFieldDef,
  cols: Set<string>,
  idx: Set<string>,
  reserve: () => boolean,
): Promise<string[]> {
  assertSafe(table, def.key);
  const col = generatedColumnName(def.key);
  const indexName = `idx_${col}`;
  const changes: string[] = [];
  if (def.type === 'multi_select') {
    if (!idx.has(indexName) && reserve()) {
      await db.raw(
        `ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` ((CAST(custom->'$.${def.key}' AS CHAR(64) ARRAY))), ALGORITHM=INPLACE, LOCK=SHARED`,
      );
      changes.push(`${table}.${indexName}`);
    }
  } else {
    const returning = RETURNING[def.type];
    const colType = COLUMN_TYPE[def.type];
    if (!returning || !colType) return changes;
    if (!cols.has(col)) {
      await db.raw(
        `ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${colType} GENERATED ALWAYS AS (JSON_VALUE(custom, '$.${def.key}' RETURNING ${returning} NULL ON EMPTY NULL ON ERROR)) VIRTUAL, ALGORITHM=INSTANT`,
      );
      cols.add(col);
      changes.push(`${table}.${col}`);
    }
    if (!idx.has(indexName) && reserve()) {
      await db.raw(
        `ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (\`${col}\`), ALGORITHM=INPLACE, LOCK=SHARED`,
      );
      changes.push(`${table}.${indexName}`);
    }
  }
  await db('custom_field_definitions')
    .where({ uuid: def.uuid })
    .update({ gen_column: def.type === 'multi_select' ? null : col });
  return changes;
}

/** Explicit admin action: drop the generated column and index of an archived field. Values stay in JSON. */
export async function dropCustomFieldIndex(entity: CustomizableEntity, key: string) {
  const table = ENTITY_TABLE[entity];
  assertSafe(table, key);
  const col = generatedColumnName(key);
  const idx = await existingIndexes(table);
  if (idx.has(`idx_${col}`)) await db.raw(`ALTER TABLE \`${table}\` DROP INDEX \`idx_${col}\``);
  const cols = await existingColumns(table);
  if (cols.has(col)) await db.raw(`ALTER TABLE \`${table}\` DROP COLUMN \`${col}\``);
  await db('custom_field_definitions').where({ entity, key }).update({ gen_column: null });
  bumpDefinitionsVersion();
}
