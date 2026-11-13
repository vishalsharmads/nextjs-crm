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
    t.string('status', 32).nullable().defaultTo('active');
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
    [`${dir}/help/${o.key}.md`]: helpArticle({
      key: o.key,
      title: plural,
      route: `/m/${o.key}/${route}, /m/${o.key}/${route}/*`,
      permission: `${resource}.view`,
      body: `Keep ${plural.toLowerCase()} with custom fields, saved views, search, import and export.\n\n## Permissions\n\n<!-- generated:permissions:${o.key}. -->`,
    }),
  };
}

function helpArticle(a: { key: string; title: string; route: string; permission: string; body: string }) {
  return `---
id: module.${a.key}
title: ${a.title}
area: Modules
route: ${a.route}
permission: ${a.permission}
module: ${a.key}
related: settings.modules
---

${a.body}
`;
}

export interface IntegrationOptions {
  /** Module key, e.g. `chat-relay`. */
  key: string;
  /** Name admins see, e.g. `Chat relay`. */
  name: string;
}

/**
 * Files of a new integration: settings fields (an address and a secret token), a connection test,
 * an event handler that queues a background job, and a help article with the settings table.
 */
export function scaffoldIntegration(o: IntegrationOptions): Record<string, string> {
  if (!MODULE_KEY_RE.test(o.key)) throw new Error('--key must be lowercase letters, digits and hyphens');
  if (!o.name.trim()) throw new Error('Pass --name=<Name admins see>');
  const dir = `modules/${o.key}`;
  const apiName = camel(o.key);
  const manifest = {
    key: o.key,
    name: o.name.trim(),
    version: '1.0.0',
    status: 'available',
    category: 'integration',
    icon: 'plug',
    description: `Sends record events from this workspace to ${o.name.trim()}.`,
    depends_on: [],
    permissions: [],
    menu_items: [],
    api_entry: 'api/index.ts',
    settings: [
      {
        key: 'endpoint',
        type: 'url',
        label: 'Address',
        help: 'Where events are sent. Must be https and reachable from the internet.',
        required: true,
      },
      {
        key: 'token',
        type: 'secret',
        label: 'Token',
        help: 'Sent with each request so the other service knows it came from this workspace. Stored encrypted.',
      },
      {
        key: 'send_deals',
        type: 'boolean',
        label: 'Send won deals',
        help: 'Send an event when a deal is won.',
        default: true,
      },
    ],
  };

  const api = `import {
  AppError,
  assertSafeUrl,
  enqueue,
  eventTouchesRestricted,
  getModuleSettings,
  isModuleEnabled,
  onEvent,
  registerJob,
  type ApiModule,
} from '@app/api/module-api';

/**
 * ${o.name.trim()}: sends chosen record events to another service.
 * Settings are declared in manifest.json and read with getModuleSettings (secrets decrypted).
 * Events are queued as jobs so a slow service never slows down saving a record.
 * See docs/integration-authoring.md.
 */

const KEY = '${o.key}';
const JOB = '${o.key}.send';

async function send(settings: Record<string, string | number | boolean>, body: Record<string, unknown>) {
  const url = String(settings.endpoint ?? '');
  await assertSafeUrl(url, 'endpoint');
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.token ? { authorization: \`Bearer \${String(settings.token)}\` } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Never pass the other service's own error text on to people.
    throw new AppError('UPSTREAM_FAILED', 'The service could not be reached.');
  }
  if (!res.ok) throw new AppError('UPSTREAM_FAILED', \`The service answered \${res.status}.\`);
}

onEvent(async (e) => {
  if (!isModuleEnabled(KEY)) return;
  const settings = await getModuleSettings(KEY);
  if (!settings.endpoint) return;
  if (e.type !== 'deal.won' || settings.send_deals !== true) return;
  // Nothing about a person whose processing is restricted leaves the workspace.
  if (await eventTouchesRestricted(e)) return;
  // Send ids and what happened, not personal data. Add fields only when the service needs them.
  await enqueue(JOB, { event: e.type, entity: e.entity, uuid: e.uuid, at: e.at });
});

registerJob(JOB, async (job) => {
  if (!isModuleEnabled(KEY)) return;
  await send(await getModuleSettings(KEY), job.payload);
});

export const ${apiName}: ApiModule = {
  testConnection: async (settings) => {
    if (!settings.endpoint) throw new AppError('UPSTREAM_FAILED', 'Add the address first.');
    await send(settings, { event: 'test' });
    return { message: 'The service accepted a test event.' };
  },
};
`;

  const pkg = {
    name: `@app/module-${o.key}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: { '@app/api': '*', '@app/module-sdk': '*' },
  };

  return {
    [`${dir}/manifest.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
    [`${dir}/package.json`]: `${JSON.stringify(pkg, null, 2)}\n`,
    [`${dir}/api/index.ts`]: api,
    [`${dir}/help/${o.key}.md`]: helpArticle({
      key: o.key,
      title: o.name.trim(),
      route: `/settings/modules/${o.key}`,
      permission: 'core.modules.manage',
      body: `Sends events from {{appName}} to ${o.name.trim()}.\n\n## Set it up\n\nTurn the module on, open **Settings**, fill in the address and token, then choose **Test connection**.\n\n## Settings\n\n<!-- generated:module-settings:${o.key} -->`,
    }),
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
export function writeScaffold(
  root: string,
  o: ScaffoldOptions | (IntegrationOptions & { integration: true }),
): string[] {
  if (existsSync(join(root, 'modules', o.key))) throw new Error(`modules/${o.key} already exists`);
  const files = 'integration' in o ? scaffoldIntegration(o) : scaffoldModule(o);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const installed = join(root, 'apps/api/src/modules/installed.ts');
  writeFileSync(installed, addToInstalled(readFileSync(installed, 'utf8'), o.key));
  return [...Object.keys(files), 'apps/api/src/modules/installed.ts'];
}
