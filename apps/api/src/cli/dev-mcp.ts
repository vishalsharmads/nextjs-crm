/**
 * Developer MCP server for AI coding agents working in a checkout of this repository.
 * It acts on files in the working tree (scaffold, check and add modules), never on a database or a
 * running instance, and is not part of the production bundle. Logs go to stderr only.
 *
 *   npm run mcp:dev          (or: npx tsx apps/api/src/cli/dev-mcp.ts, so npm's banner never reaches stdout)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MODULE_KEY_RE, moduleManifestSchema } from '@app/module-sdk';
import { writeScaffold } from './scaffold';
import { BRAND_ALLOWED, brandHits, checkModuleFolder } from './module-check';
import { addCatalogModule, loadCatalog } from './module-add';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `You are working in a white-label, single-organization CRM monorepo. Industry features are modules in modules/<key>.
Rules for modules (module_validate checks most of them):
- API code imports only from "@app/api/module-api"; web code may use the app's "@/..." components.
- Tables are named m_<key>_* (hyphens as underscores) and created in api/migrations; committed migrations are immutable.
- A module that stores data about contacts or leads must return a PrivacyHandler (export and erase).
- Outbound calls: assertSafeUrl, a timeout, no redirects, background jobs (enqueue), skip eventTouchesRestricted events.
- Settings go in manifest.json "settings" (types string, secret, boolean, select, number, url; every field needs help); read them with getModuleSettings.
- No vendor, product or company names anywhere; no hardcoded colors in web code (theme tokens like bg-primary).
- Every module needs help/<key>.md; add <!-- generated:module-settings:<key> --> when it has settings.
Start with docs_read("module-authoring"), scaffold with module_scaffold, then run module_validate until it passes. Then run the repository's typecheck, lint and tests.`;

const DOCS: Record<string, string> = {
  'module-authoring': 'docs/module-authoring.md',
  'integration-authoring': 'docs/integration-authoring.md',
  integrations: 'docs/integrations.md',
  agents: 'AGENTS.md',
};

const keySchema = z.string().regex(MODULE_KEY_RE, 'lowercase letters, digits and hyphens');

interface DevTool {
  name: string;
  description: string;
  input: z.ZodType;
  write?: boolean;
  run: (root: string, args: never) => unknown;
}

const tool = <S extends z.ZodType>(t: {
  name: string;
  description: string;
  input: S;
  write?: boolean;
  run: (root: string, args: z.output<S>) => unknown;
}): DevTool => t as unknown as DevTool;

function installedKeys(root: string): string[] {
  const src = readFileSync(join(root, 'apps/api/src/modules/installed.ts'), 'utf8');
  return [...src.matchAll(/modules\/([a-z0-9-]+)\/manifest\.json/g)].map((m) => m[1]!);
}

function moduleDirs(root: string): string[] {
  const dir = join(root, 'modules');
  return existsSync(dir) ? readdirSync(dir).filter((k) => existsSync(join(dir, k, 'manifest.json'))) : [];
}

export const DEV_TOOLS: DevTool[] = [
  tool({
    name: 'module_list',
    description:
      'List the modules in this checkout with name, version, category, settings and whether installed.ts registers them.',
    input: z.object({}),
    run: (root) => {
      const installed = installedKeys(root);
      return {
        modules: moduleDirs(root).map((key) => {
          const parsed = moduleManifestSchema.safeParse(
            JSON.parse(readFileSync(join(root, 'modules', key, 'manifest.json'), 'utf8')),
          );
          return parsed.success
            ? {
                key,
                name: parsed.data.name,
                version: parsed.data.version,
                category: parsed.data.category,
                dependsOn: parsed.data.depends_on,
                settings: parsed.data.settings.map((f) => `${f.key} (${f.type})`),
                registered: installed.includes(key),
              }
            : { key, invalidManifest: true, registered: installed.includes(key) };
        }),
      };
    },
  }),
  tool({
    name: 'module_scaffold',
    description:
      'Generate a new module in modules/<key> and register it in installed.ts. kind "record" makes a record type (list, detail, custom fields, import/export) and needs entity and plural; kind "integration" makes settings, an event handler, a background job and a connection test, and needs name. Run npm install afterwards.',
    input: z.object({
      kind: z.enum(['record', 'integration']),
      key: keySchema,
      entity: z.string().optional().describe('record: new record type key, e.g. vehicle'),
      plural: z.string().optional().describe('record: plural label, e.g. Vehicles'),
      singular: z.string().optional(),
      personal: z
        .boolean()
        .optional()
        .describe('record: the records describe people (adds a privacy handler stub)'),
      name: z.string().optional().describe('integration: the name admins see'),
    }),
    write: true,
    run: (root, a) => {
      const files =
        a.kind === 'integration'
          ? writeScaffold(root, { key: a.key, name: a.name ?? '', integration: true })
          : writeScaffold(root, {
              key: a.key,
              entity: a.entity ?? '',
              plural: a.plural ?? '',
              singular: a.singular,
              personal: a.personal,
            });
      return {
        written: files,
        next: ['npm install', `module_validate {"key":"${a.key}"}`, 'npm run typecheck'],
      };
    },
  }),
  tool({
    name: 'module_validate',
    description:
      'Check one module against the module rules: manifest, folder name, dependencies, help article, imports, table names, unsafe APIs, brand names, and registration in installed.ts. Returns problems; an empty list passes.',
    input: z.object({ key: keySchema }),
    run: (root, { key }) => {
      const dir = join(root, 'modules', key);
      if (!existsSync(dir)) return { ok: false, problems: [`modules/${key} does not exist`] };
      const problems = checkModuleFolder(root, dir);
      if (!installedKeys(root).includes(key))
        problems.push(
          'not listed in apps/api/src/modules/installed.ts (module_scaffold and module_add do this)',
        );
      return { ok: problems.length === 0, problems };
    },
  }),
  tool({
    name: 'module_api_reference',
    description:
      'What module API code may import from "@app/api/module-api" (the whole contract, with doc comments), and the event names modules can react to.',
    input: z.object({}),
    run: (root) => {
      const events = readFileSync(join(root, 'apps/api/src/core/events/events.ts'), 'utf8');
      const list = events.slice(events.indexOf('EVENT_TYPES = ['), events.indexOf('] as const'));
      return {
        moduleApi: readFileSync(join(root, 'apps/api/src/module-api.ts'), 'utf8'),
        events: [...list.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]),
        recordTypeEvents: '<entity>.created, <entity>.updated, <entity>.deleted for module record types',
      };
    },
  }),
  tool({
    name: 'brand_check',
    description:
      'Find vendor, product or company names (the brand deny list) in one module, or in every module.',
    input: z.object({ key: keySchema.optional() }),
    run: (root, { key }) => {
      const keys = key ? [key] : moduleDirs(root);
      const hits = keys.flatMap((k) => brandHits(root, join(root, 'modules', k), BRAND_ALLOWED));
      return { ok: hits.length === 0, hits };
    },
  }),
  tool({
    name: 'docs_read',
    description: `Read a developer guide: ${Object.keys(DOCS).join(', ')}.`,
    input: z.object({ doc: z.enum(Object.keys(DOCS) as [string, ...string[]]) }),
    run: (root, { doc }) => ({ doc, text: readFileSync(join(root, DOCS[doc]!), 'utf8') }),
  }),
  tool({
    name: 'module_add',
    description:
      'Add a module from the module catalog (MODULE_CATALOG_URL, or the catalog given) at its pinned commit. Refuses moved tags and modules that fail module_validate. The change is left in the working tree for review.',
    input: z.object({ key: keySchema, catalog: z.string().optional(), update: z.boolean().optional() }),
    write: true,
    run: async (root, a) => {
      const source = a.catalog ?? process.env.MODULE_CATALOG_URL;
      if (!source) throw new Error('No catalog: pass catalog or set MODULE_CATALOG_URL');
      const entry = (await loadCatalog(source, process.env.MODULE_CATALOG_TOKEN)).find(
        (e) => e.key === a.key,
      );
      if (!entry) throw new Error(`"${a.key}" is not in the catalog`);
      const { dir, problems } = addCatalogModule({ root, entry, update: a.update });
      return problems.length
        ? { added: false, problems }
        : {
            added: true,
            dir,
            version: entry.version,
            commit: entry.sha,
            next: ['npm install', 'review and commit'],
          };
    },
  }),
];

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handle(root: string, method: string, params: Record<string, unknown>) {
  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'module-dev', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: DEV_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
          annotations: { readOnlyHint: !t.write, destructiveHint: false },
        })),
      };
    case 'tools/call': {
      const t = DEV_TOOLS.find((x) => x.name === params.name);
      if (!t) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
      try {
        const args = t.input.parse(params.arguments ?? {}) as never;
        const result = (await t.run(root, args)) as Record<string, unknown>;
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        const message =
          err instanceof z.ZodError
            ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : (err as Error).message;
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    }
    case 'resources/list':
      return {
        resources: Object.entries(DOCS).map(([name, path]) => ({
          uri: `docs://${name}`,
          name,
          title: path,
          mimeType: 'text/markdown',
        })),
      };
    case 'resources/read': {
      const name = String(params.uri ?? '').replace(/^docs:\/\//, '');
      const path = DOCS[name];
      if (!path) throw new RpcError(-32602, 'Unknown resource');
      return {
        contents: [
          { uri: `docs://${name}`, mimeType: 'text/markdown', text: readFileSync(join(root, path), 'utf8') },
        ],
      };
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** One JSON-RPC message in, the response out (undefined for notifications). */
export async function handleDevMessage(root: string, line: string): Promise<string | undefined> {
  let id: string | number | null = null;
  try {
    const msg = JSON.parse(line) as {
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    id = msg.id ?? null;
    if (typeof msg.method !== 'string') throw new RpcError(-32600, 'Invalid request');
    // Notifications (no id) never get an answer, not even an error.
    if (msg.id === undefined || msg.id === null) {
      if (!msg.method.startsWith('notifications/'))
        await handle(root, msg.method, msg.params ?? {}).catch(() => undefined);
      return undefined;
    }
    const result = await handle(root, msg.method, msg.params ?? {});
    return msg.id === undefined || msg.id === null
      ? undefined
      : JSON.stringify({ jsonrpc: '2.0', id, result });
  } catch (err) {
    const code = err instanceof RpcError ? err.code : err instanceof SyntaxError ? -32700 : -32603;
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: (err as Error).message } });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const rl = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      const out = await handleDevMessage(root, line);
      if (out) process.stdout.write(`${out}\n`);
    });
  });
  rl.on('close', () => void queue.then(() => process.exit(0)));
  process.stderr.write('module-dev MCP server ready\n');
}
