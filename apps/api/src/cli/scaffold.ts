import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENTITY_KEY_PATTERN, isCoreEntity, LABEL_ENTITY_KEYS } from '@app/shared';
import { MODULE_KEY_RE } from '@app/module-sdk';

export interface ScaffoldOptions {
  /** Module key, e.g. `properties`. */
  key: string;
  /** Record type key, e.g. `property`. */
  entity: string;
  /** Plural label, e.g. `Properties`. */
  plural: string;
  /** Singular label (defaults to the entity key in sentence case). */
  singular?: string;
  /** The records describe people: generate a privacy handler stub. */
  personal?: boolean;
}

const camel = (s: string) => s.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** Files of a new module with one record type, keyed by path relative to the repo root. */
export function scaffoldModule(o: ScaffoldOptions): Record<string, string> {
  if (!MODULE_KEY_RE.test(o.key)) throw new Error('--key must be lowercase letters, digits and hyphens');
  if (!ENTITY_KEY_PATTERN.test(o.entity) || isCoreEntity(o.entity))
    throw new Error('--entity must be a new lowercase key (letters, digits, underscores)');
  if ((LABEL_ENTITY_KEYS as readonly string[]).includes(o.entity))
    throw new Error(`--entity "${o.entity}" is reserved`);
  if (!o.plural.trim()) throw new Error('Pass --plural=<Plural label>');

  const singular = o.singular?.trim() || sentence(o.entity);
  const plural = o.plural.trim();
  const route = plural
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const resourceKey = route.replace(/-/g, '_');
  const resource = `${o.key}.${resourceKey}`;
  const table = `m_${o.key.replace(/-/g, '_')}_${resourceKey}`;
  const apiName = camel(o.key);
  const dir = `modules/${o.key}`;
  const actions = ['view', 'create', 'update', 'delete', 'export', 'import', 'assign', 'bulk'];

  const manifest = {
    key: o.key,
    name: plural,
    version: '1.0.0',
    status: 'available',
    description: `${plural} with custom fields, views, search, import and export.`,
    depends_on: [],
    permissions: actions.map((a) => ({
      key: `${resource}.${a}`,
      description: `${sentence(a)} ${plural.toLowerCase()}`,
    })),
    menu_items: [
      {
        key: resourceKey,
        label: plural,
        path: `/m/${o.key}/${route}`,
        icon: 'box',
        permission: `${resource}.view`,
        order: 60,
      },
    ],
    migrations_dir: 'api/migrations',
    api_entry: 'api/index.ts',
    web_entry: 'web/index.tsx',
    labels: { [o.entity]: { singular, plural } },
  };

  const migration = `import type { Knex } from 'knex';

const TABLE = '${table}';

export async function up(knex: Knex) {
  await knex.schema.createTable(TABLE, (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('name', 200).notNullable();
    t.string('status', 32).notNullable().defaultTo('active');
    t.text('notes').nullable();
    t.bigInteger('owner_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.json('custom').notNullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.bigInteger('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    t.datetime('deleted_at').nullable();
    t.index(['owner_id']);
    t.index(['deleted_at', 'created_at']);
  });
  // Must list exactly the searchable columns of the record type, in order.
  await knex.raw(\`ALTER TABLE \${TABLE} ADD FULLTEXT INDEX ft_\${TABLE} (name)\`);
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists(TABLE);
}
`;

  const privacyImport = o.personal ? ', type PrivacyHandler' : '';
  const privacy = o.personal
    ? `
/**
 * These records describe people: export and erase what belongs to a data subject.
 * Fill in how a record links to a contact or lead before enabling the module on a live instance.
 */
const privacy: PrivacyHandler = {
  key: '${o.key}',
  tables: ['${table}'],
  viewPermission: '${resource}.view',
  async export() {
    return {};
  },
  async erase() {
    return {};
  },
};
`
    : '';

  const api = `import { defineRecordType, type ApiModule${privacyImport} } from '@app/api/module-api';
import * as m0001 from './migrations/0001_${resourceKey}';

/**
 * ${plural}: a record type on the shared records engine. It gets list, detail, create, edit,
 * delete and restore, custom fields, saved views, search, import/export, bulk actions, trash,
 * automations, audit and own/team/all scope without further code.
 * Add columns here and in a new migration (committed migrations are immutable).
 */
export const ${camel(o.entity)}Type = defineRecordType({
  moduleKey: '${o.key}',
  entity: '${o.entity}',
  route: '${route}',
  table: '${table}',
  resource: '${resource}',
  labels: { singular: '${singular}', plural: '${plural}' },
  titleColumn: 'name',
  columns: [
    { key: 'name', label: 'Name', kind: 'text', required: true, max: 200, searchable: true },
    {
      key: 'status',
      label: 'Status',
      kind: 'select',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'inactive', label: 'Inactive' },
      ],
    },
    { key: 'notes', label: 'Notes', kind: 'textarea' },
  ],
  defaultColumns: ['name', 'status', 'owner', 'updated_at'],
});
${privacy}
export const ${apiName}: ApiModule = {
  migrations: { '0001_${resourceKey}': m0001 },
  recordTypes: [${camel(o.entity)}Type],${o.personal ? '\n  privacy,' : ''}
};
`;

  const web = `import type { WebModule } from '@app/module-sdk';

/**
 * List, detail and trash pages of this module's record types are added by the app from the
 * record type definition. Add routes here only for screens beyond those.
 */
const mod: WebModule = { key: '${o.key}', routes: [] };

export default mod;
`;

  const pkg = {
    name: `@app/module-${o.key}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: { '@app/api': '*', '@app/module-sdk': '*', '@app/shared': '*' },
  };

  return {
    [`${dir}/manifest.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
    [`${dir}/package.json`]: `${JSON.stringify(pkg, null, 2)}\n`,
    [`${dir}/api/index.ts`]: api,
    [`${dir}/api/migrations/0001_${resourceKey}.ts`]: migration,
    [`${dir}/web/index.tsx`]: web,
  };
}

/** Add the module to `installed.ts`. Returns the new file content. */
export function addToInstalled(source: string, key: string): string {
  const name = camel(key);
  if (source.includes(`modules/${key}/manifest.json`)) return source;
  const imports = `import ${name} from '../../../../modules/${key}/manifest.json' with { type: 'json' };\nimport { ${name} as ${name}Api } from '../../../../modules/${key}/api';\n`;
  const lastImport = source.lastIndexOf('\nimport ');
  const insertAt = source.indexOf('\n', lastImport + 1) + 1;
  const withImport = source.slice(0, insertAt) + imports + source.slice(insertAt);
  const close = withImport.lastIndexOf('];');
  return `${withImport.slice(0, close)}  { manifest: ${name}, api: ${name}Api },\n${withImport.slice(close)}`;
}

/** Write a scaffolded module under `root`. Refuses to overwrite an existing module folder. */
export function writeScaffold(root: string, o: ScaffoldOptions): string[] {
  if (existsSync(join(root, 'modules', o.key))) throw new Error(`modules/${o.key} already exists`);
  const files = scaffoldModule(o);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const installed = join(root, 'apps/api/src/modules/installed.ts');
  writeFileSync(installed, addToInstalled(readFileSync(installed, 'utf8'), o.key));
  return [...Object.keys(files), 'apps/api/src/modules/installed.ts'];
}
