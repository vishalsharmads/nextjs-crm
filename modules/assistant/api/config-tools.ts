import { z } from 'zod';
import { AppError, callRoute, routeRegistry, type HttpMethod, type ToolDef } from '@app/api/module-api';

/**
 * Tools that read and change how the workspace is configured, by calling the app's own routes
 * in-process as the admin (`callRoute`): the same permission checks, validation, business rules
 * and audit as the settings screens, with the audit naming the assistant. Offered only to admins,
 * only after an admin turns setup on, and every change waits for the admin to confirm it.
 *
 * Areas come from the route registry, so new settings appear without changes here. The guards:
 * only the prefixes below; never a delete; never the paths in `NEVER`; never granting `*` or
 * editing the Admin role.
 */
interface Area {
  key: string;
  title: string;
  prefixes: string[];
}

const AREAS: Area[] = [
  { key: 'names', title: 'Names records use (vocabulary)', prefixes: ['/labels'] },
  { key: 'settings', title: 'Workspace settings and branding', prefixes: ['/settings'] },
  {
    key: 'fields',
    title: 'Custom fields, field groups and layouts',
    prefixes: ['/custom-fields', '/custom-field-groups', '/layouts'],
  },
  { key: 'pipelines', title: 'Pipelines and stages', prefixes: ['/pipelines'] },
  { key: 'access', title: 'Roles and teams', prefixes: ['/roles', '/teams', '/permissions'] },
  { key: 'automations', title: 'Automations', prefixes: ['/automations'] },
  { key: 'templates', title: 'Email templates and saved replies', prefixes: ['/templates'] },
  { key: 'forms', title: 'Web forms', prefixes: ['/forms'] },
  { key: 'views', title: 'Saved views and tags', prefixes: ['/saved-views', '/tags'] },
  { key: 'reports', title: 'Reports and dashboards', prefixes: ['/reports/custom', '/dashboards'] },
  { key: 'objects', title: 'Admin-defined objects', prefixes: ['/objects'] },
  { key: 'modules', title: 'Modules (turn on or off)', prefixes: ['/modules'] },
];

/**
 * Never through the assistant, whatever the area: protection and secrets (security, compliance,
 * MCP and demo settings, uploads), things that send data out or reveal it, and anything that runs
 * reports over records (that is what the record tools and their exclusions are for).
 */
const NEVER = [
  /^\/settings\/(security|compliance|mcp)(\/|$)/,
  /^\/settings\/demo/,
  /^\/settings\/demo-login/,
  // Sends email out.
  /^\/settings\/email\/test$/,
  /^\/settings\/branding\/assets/,
  // Payment instructions and legal details print on invoices: changing them is fraud-shaped.
  /^\/settings\/commerce(\/|$)/,
  // Turning the assistant off from inside a conversation (an admin can in Settings).
  /^\/modules\/assistant\/disable$/,
  // Module settings can hold credentials, and a connection test calls out to another service.
  /^\/modules\/[^/]+\/(settings|test)$/,
  /\/reveal$/,
  /\/export$/,
  /\/preview$/,
  /\/run$/,
  /\/runs$/,
  /\/render$/,
  /^\/dashboards\/widgets\//,
  /\/drop-index$/,
];

const WRITE_METHODS: HttpMethod[] = ['post', 'put', 'patch'];

export interface ConfigRoute {
  area: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  write: boolean;
}

/** Every route the assistant may use, by area. Deletes never appear here. */
export function configRoutes(): ConfigRoute[] {
  const out: ConfigRoute[] = [];
  for (const r of routeRegistry) {
    if (r.method === 'delete' || r.permission === 'public') continue;
    if (NEVER.some((re) => re.test(r.path))) continue;
    const area = AREAS.find((a) => a.prefixes.some((p) => r.path === p || r.path.startsWith(`${p}/`)));
    if (!area) continue;
    out.push({
      area: area.key,
      method: r.method,
      path: r.path,
      summary: r.summary,
      write: r.method !== 'get',
    });
  }
  return out;
}

function patternOf(path: string) {
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-zA-Z]+/g, '[^/]+')}$`);
}

/** The allowed route a call would reach, or a refusal the model can read. */
function allowed(method: HttpMethod, path: string): ConfigRoute {
  const clean = path.split('?')[0]!.replace(/\/+$/, '') || '/';
  if (NEVER.some((re) => re.test(clean)))
    throw new AppError('FORBIDDEN', 'The assistant may not change this; an admin can do it in Settings');
  const route = configRoutes().find((r) => r.method === method && patternOf(r.path).test(clean));
  if (!route)
    throw new AppError(
      'FORBIDDEN',
      `The assistant may not use ${method.toUpperCase()} ${clean}. Call config_overview for what it can change.`,
    );
  return route;
}

/** Changes that need more than a route check. */
/** Settings groups the assistant never reads or changes. */
const HIDDEN_SETTINGS = ['security', 'compliance', 'mcp'];

type Tc = Parameters<ToolDef['handler']>[1];
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const refuse = (why: string): never => {
  throw new AppError('FORBIDDEN', `${why}; an admin can do this in Settings`);
};

/** Changes that need more than a route check. Fails closed: a lookup that fails refuses. */
async function assertSafeChange(method: HttpMethod, path: string, body: unknown, tc: Tc) {
  const b = isObj(body) ? body : {};

  // Sign-in emails (password reset, invites) carry one-time links: a changed template could leak them.
  if (path.startsWith('/templates')) {
    if (typeof b.key === 'string' && b.key.startsWith('auth.'))
      refuse('The assistant may not change sign-in emails');
    const uuid = /^\/templates\/([^/]+)$/.exec(path)?.[1];
    if (uuid) {
      const list = (await callRoute('get', '/templates', {}, tc)) as {
        data?: { uuid: string | null; key: string }[];
      };
      const t = list.data?.find((x) => x.uuid === uuid);
      if (!t || t.key.startsWith('auth.')) refuse('The assistant may not change sign-in emails');
    }
  }

  // Where mail appears to come from.
  if (path === '/settings/branding' && Object.keys(b).some((k) => k.toLowerCase().startsWith('email')))
    refuse('The assistant may not change the sender of emails');

  // Automations may not email people: that is how data leaves, or phishing arrives.
  if (path.startsWith('/automations')) {
    const actions = Array.isArray(b.actions) ? b.actions : [];
    if (actions.some((a) => isObj(a) && a.type === 'send_email'))
      refuse('The assistant may not create automations that send email');
  }

  // Team membership widens what people can see.
  if (path.startsWith('/teams') && ('memberUuids' in b || 'leadUuids' in b))
    refuse('The assistant may not change who is in a team');

  if (path.startsWith('/roles')) {
    const permissions = Array.isArray(b.permissions) ? b.permissions.map(String) : undefined;
    if (permissions?.includes('*')) refuse('The assistant may not grant every permission (*)');
    const uuid = /^\/roles\/([^/]+)/.exec(path)?.[1];
    if (uuid && method !== 'post') {
      const role = (await callRoute('get', `/roles/${uuid}`, {}, tc).catch(() => null)) as {
        key?: string;
        permissions?: string[];
        scopes?: Record<string, string>;
      } | null;
      if (!role) refuse('The assistant could not check this role');
      if (role!.key === 'admin') refuse('The assistant may not change the Admin role');
      // An existing role may lose access through the assistant, never gain it.
      const had = new Set(role!.permissions ?? []);
      const added = (permissions ?? []).filter((p) => !had.has(p));
      if (added.length)
        refuse(`The assistant may not add permissions to an existing role (${added.join(', ')})`);
      const RANK: Record<string, number> = { own: 0, team: 1, all: 2 };
      const scopes = isObj(b.scopes) ? b.scopes : {};
      const wider = Object.entries(scopes).filter(
        ([res, scope]) => (RANK[String(scope)] ?? 3) > (RANK[role!.scopes?.[res] ?? 'own'] ?? 0),
      );
      if (wider.length) refuse('The assistant may not widen what a role can see');
    }
  }
}

/** What the person confirms, written by the server from the route, never by the model. */
/** What each kind of configuration is called, by the route segment that names it. */
const NOUNS: Record<string, string> = {
  labels: 'record names',
  settings: 'settings',
  branding: 'branding',
  'custom-fields': 'custom field',
  'custom-field-groups': 'field group',
  layouts: 'layout',
  pipelines: 'pipeline',
  stages: 'stage',
  order: 'order',
  roles: 'role',
  teams: 'team',
  automations: 'automation',
  templates: 'template',
  forms: 'web form',
  'saved-views': 'saved view',
  tags: 'tag',
  custom: 'report',
  dashboards: 'dashboard',
  objects: 'object',
  modules: 'module',
};

/**
 * What a configuration change does, in a short sentence written by the server from the route
 * (never by the model): "Create a report", "Update a dashboard", "Turn off a module".
 */
export function describeChange(method: string, path: string, _body?: unknown): string {
  const segs = path.split('/').filter((x) => x && !/^[0-9a-f-]{36}$/.test(x));
  const action = /^(archive|restore|enable|disable)$/.exec(segs.at(-1) ?? '')?.[1];
  const nounSeg = [...segs].reverse().find((x) => NOUNS[x] && x !== 'order') ?? segs[0] ?? '';
  const noun = NOUNS[nounSeg] ?? 'configuration';
  if (segs.at(-1) === 'order') return `Reorder ${noun}s`;
  if (nounSeg === 'settings' || nounSeg === 'labels' || nounSeg === 'branding')
    return `Update ${segs[0] === 'settings' && segs[1] && segs[1] !== 'branding' ? `${segs[1]} settings` : noun}`;
  const a = /^[aeiou]/.test(noun) ? 'an' : 'a';
  if (action === 'enable') return `Turn on ${a} ${noun}`;
  if (action === 'disable') return `Turn off ${a} ${noun}`;
  if (action) return `${action[0]!.toUpperCase()}${action.slice(1)} ${a} ${noun}`;
  return `${method === 'post' ? 'Create' : 'Update'} ${a} ${noun}`;
}

const method = z.enum(['get', 'post', 'put', 'patch']);
const apiPath = z
  .string()
  .regex(/^\/[A-Za-z0-9/_:.-]*$/, 'An API path such as /pipelines or /custom-fields/<uuid>')
  .max(300);

/** Input and body shapes for one route, as JSON Schema, so the model can write a valid change. */
function schemaOf(r: (typeof routeRegistry)[number]) {
  const json = (s?: z.ZodType) => {
    if (!s) return undefined;
    try {
      return z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
    } catch {
      return { description: 'Not describable; read the current value first and send the same shape.' };
    }
  };
  return { method: r.method, path: r.path, summary: r.summary, query: json(r.query), body: json(r.body) };
}

/**
 * Checks a proposed change before the admin is asked to confirm it, so a change that can never run
 * goes back to the model as an error instead of becoming a question. Throws an AppError.
 */
export async function precheckConfigChange(input: unknown, tc: Parameters<ToolDef['handler']>[1]) {
  const change = CONFIG_TOOLS.find((t) => t.name === 'config_change')!.input.safeParse(input);
  if (!change.success)
    throw new AppError(
      'VALIDATION_FAILED',
      'The tool input is not valid',
      change.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  const { method: m, path, body: raw } = change.data as { method: HttpMethod; path: string; body?: unknown };
  const body = bodyOf(raw);
  allowed(m, path);
  await assertSafeChange(m, path, body, tc);
  // The route's own format, checked now so a change that cannot run is never put to the person.
  await callRoute(m, path, { body: body ?? {} }, tc, { validateOnly: true });
}

/** Models sometimes send the body as JSON text instead of an object: read it as the object. */
export function bodyOf(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export const CONFIG_TOOLS: ToolDef[] = [
  {
    name: 'config_overview',
    title: 'Look at what can be configured',
    description:
      'Lists the configuration areas the assistant may read and change (names, settings, fields, layouts, pipelines, roles, teams, automations, templates, forms, views, reports, dashboards, objects, modules), with each allowed API route. Security, compliance, users, API keys, webhooks, email accounts and deletes are never available.',
    write: false,
    input: z.object({ area: z.string().max(40).optional().describe('Only this area key') }),
    handler: async ({ area }) => {
      const routes = configRoutes().filter((r) => !area || r.area === area);
      return {
        areas: AREAS.filter((a) => !area || a.key === area).map((a) => ({
          key: a.key,
          title: a.title,
          routes: routes
            .filter((r) => r.area === a.key)
            .map((r) => `${r.method.toUpperCase()} ${r.path}${r.summary ? ` (${r.summary})` : ''}`),
        })),
      };
    },
  },
  {
    name: 'config_schema',
    title: 'Look up a configuration format',
    description:
      'The exact query and body format (JSON Schema) for one allowed route from config_overview. Call it before config_change to send a valid body.',
    write: false,
    input: z.object({ method, path: apiPath.describe('The route as listed, e.g. /pipelines/:uuid/stages') }),
    handler: async ({ method: m, path }) => {
      allowed(m, path.replace(/:[a-zA-Z]+/g, 'x'));
      const r =
        routeRegistry.find((x) => x.method === m && x.path === path) ??
        routeRegistry.find((x) => x.method === m && patternOf(x.path).test(path));
      if (!r) throw new AppError('NOT_FOUND', 'Use a route from config_overview');
      return schemaOf(r);
    },
  },
  {
    name: 'config_read',
    title: 'Read the configuration',
    description:
      'Reads current configuration with an allowed GET route from config_overview, with real ids in the path (e.g. /pipelines, /custom-fields?entity=deal, /roles/<uuid>). Always read before changing.',
    write: false,
    input: z.object({
      path: apiPath,
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
    handler: async ({ path, query }, tc) => {
      allowed('get', path);
      const clean = path.split('?')[0]!.replace(/\/+$/, '');
      const result = await callRoute('get', clean, { query: query ?? {} }, tc);
      // All settings at once: leave out the groups the assistant never touches.
      if (clean === '/settings' && isObj(result))
        return Object.fromEntries(Object.entries(result).filter(([k]) => !HIDDEN_SETTINGS.includes(k)));
      return result;
    },
  },
  {
    name: 'config_change',
    title: 'Change the configuration',
    description:
      'Makes one configuration change with an allowed POST, PUT or PATCH route from config_overview, after the admin confirms. Read the current value and the format (config_schema) first. Send only the fields that change. Never deletes; to retire something, archive or turn it off where the area allows.',
    write: true,
    input: z.object({
      method: method.exclude(['get']),
      path: apiPath,
      body: z.unknown().optional(),
      summary: z
        .string()
        .trim()
        .min(3)
        .max(200)
        .describe('One plain sentence the admin sees, e.g. "Add a Renewal stage to the Sales pipeline"'),
    }),
    handler: async ({ method: m, path, body: raw }, tc) => {
      if (!WRITE_METHODS.includes(m)) throw new AppError('FORBIDDEN', 'Only additions and edits are allowed');
      const body = bodyOf(raw);
      allowed(m, path);
      await assertSafeChange(m, path, body, tc);
      const result = await callRoute(m, path, { body: body ?? {} }, tc);
      return result === undefined ? { ok: true } : result;
    },
  },
] as ToolDef[];

export const CONFIG_PROMPT = [
  'You can also configure this CRM for the admin with config_overview, config_schema, config_read and config_change.',
  'Before a change: read the current configuration (config_read) and the format (config_schema). Send one change per config_change, with a short summary in plain words; the admin confirms each one.',
  'You cannot delete anything or touch security, compliance, users, API keys, webhooks or email accounts: say an admin can do that in Settings.',
  'Prefer the workspace setup tools (preview_setup, apply_setup) for adding many fields, pipelines or roles at once.',
  'Bodies are JSON objects, never JSON text. For a new chart on a dashboard: create the report (POST /reports/custom with a name and a definition, as run_report takes), then PUT /dashboards/<uuid> with the full widget list, keeping the existing widgets and adding {"key": "...", "type": "report", "title": "...", "params": {"report": "<the new report uuid>"}}.',
].join('\n');
