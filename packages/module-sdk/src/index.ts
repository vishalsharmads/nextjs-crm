import { z } from 'zod';
import { PERMISSION_KEY_RE } from '@app/shared';

export const MODULE_KEY_RE = /^[a-z][a-z0-9-]{1,63}$/;

/** Keys of module settings fields (same rule as custom field keys). */
export const MODULE_SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,48}$/;

export const MODULE_CATEGORIES = ['integration', 'industry', 'productivity', 'commerce'] as const;
export type ModuleCategory = (typeof MODULE_CATEGORIES)[number];

/**
 * One field an admin fills in on the module's Settings tab. `secret` values are stored encrypted
 * and never leave the API; `help` is required because it is shown under the field and in help.
 */
export const moduleSettingFieldSchema = z
  .object({
    key: z.string().regex(MODULE_SETTING_KEY_RE),
    type: z.enum(['string', 'secret', 'boolean', 'select', 'number', 'url']),
    label: z.string().min(1).max(80),
    help: z.string().min(1).max(300),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z
      .array(z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(80) }))
      .optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === 'select' && !f.options?.length)
      ctx.addIssue({ code: 'custom', message: `Setting ${f.key} needs options`, path: ['options'] });
    if (f.type === 'secret' && f.default !== undefined)
      ctx.addIssue({ code: 'custom', message: `Secret ${f.key} cannot have a default`, path: ['default'] });
  });

export type ModuleSettingField = z.output<typeof moduleSettingFieldSchema>;

export const moduleManifestSchema = z
  .object({
    key: z.string().regex(MODULE_KEY_RE),
    name: z.string().min(1).max(100),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().max(500).default(''),
    status: z.enum(['available', 'stub']).default('available'),
    depends_on: z.array(z.string().regex(MODULE_KEY_RE)).default([]),
    permissions: z
      .array(z.object({ key: z.string().regex(PERMISSION_KEY_RE), description: z.string().max(255) }))
      .default([]),
    menu_items: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          label: z.string().min(1).max(60),
          path: z.string().regex(/^\/m\/[a-z0-9/_-]+$/),
          icon: z.string().max(40).default('box'),
          permission: z.string().regex(PERMISSION_KEY_RE),
          order: z.number().int().default(100),
        }),
      )
      .default([]),
    category: z.enum(MODULE_CATEGORIES).default('productivity'),
    /** Icon key from the curated map in the web shell (`app/shell/nav.ts`). */
    icon: z.string().max(40).default('box'),
    settings: z.array(moduleSettingFieldSchema).max(30).default([]),
    migrations_dir: z.string().optional(),
    api_entry: z.string().optional(),
    web_entry: z.string().optional(),
    labels: z
      .record(
        z.string(),
        z.object({ singular: z.string().min(1).max(60), plural: z.string().min(1).max(60) }),
      )
      .default({}),
    /** Tabs a module adds to core record pages (rendered by the web entry's `panels`). */
    record_panels: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          entity: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
          title: z.string().min(1).max(60),
          permission: z.string().regex(PERMISSION_KEY_RE),
          order: z.number().int().default(100),
        }),
      )
      .default([]),
    /** Side panels opened from the top bar on every page (rendered by `panels` in the web entry). */
    shell_panels: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          title: z.string().min(1).max(60),
          icon: z.string().max(40).default('box'),
          permission: z.string().regex(PERMISSION_KEY_RE),
        }),
      )
      .default([]),
    dashboard_widgets: z
      .array(
        z.object({ type: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9_.-]+$/), title: z.string().max(100) }),
      )
      .default([]),
  })
  .superRefine((m, ctx) => {
    const keys = m.settings.map((f) => f.key);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', message: 'Setting keys must be unique', path: ['settings'] });
    for (const p of m.permissions) {
      if (!p.key.startsWith(`${m.key}.`)) {
        ctx.addIssue({
          code: 'custom',
          message: `Permission ${p.key} must start with "${m.key}."`,
          path: ['permissions'],
        });
      }
    }
  });

/**
 * A module catalog (`catalog.json` in a git repository): modules that can be added to a checkout
 * with `module:add`, each pinned to a tag and the commit it pointed at when it was listed.
 */
export const moduleCatalogSchema = z.object({
  modules: z
    .array(
      z.object({
        key: z.string().regex(MODULE_KEY_RE),
        name: z.string().min(1).max(100),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        description: z.string().max(500).default(''),
        category: z.enum(MODULE_CATEGORIES).default('productivity'),
        repo: z.url({ protocol: /^https$/ }).max(500),
        tag: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        /** Folder inside the repository that holds the module (`manifest.json` at its root). */
        path: z
          .string()
          .regex(/^[A-Za-z0-9._/-]{0,200}$/)
          .default(''),
      }),
    )
    .max(500),
});
export type ModuleCatalog = z.output<typeof moduleCatalogSchema>;
export type ModuleCatalogEntry = ModuleCatalog['modules'][number];

/** Compare two `x.y.z` versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export type ModuleManifest = z.output<typeof moduleManifestSchema>;
export type ModuleManifestInput = z.input<typeof moduleManifestSchema>;

export interface ModuleMenuItem {
  moduleKey: string;
  key: string;
  label: string;
  path: string;
  icon: string;
  permission: string;
  order: number;
}

/** Order modules so each comes after its dependencies. Throws on cycles or missing dependencies. */
export function sortByDependencies(manifests: ModuleManifest[]): ModuleManifest[] {
  const byKey = new Map(manifests.map((m) => [m.key, m]));
  const out: ModuleManifest[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (m: ModuleManifest, trail: string[]) => {
    if (state.get(m.key) === 'done') return;
    if (state.get(m.key) === 'visiting')
      throw new Error(`Module dependency cycle: ${[...trail, m.key].join(' → ')}`);
    state.set(m.key, 'visiting');
    for (const dep of m.depends_on) {
      const d = byKey.get(dep);
      if (!d) throw new Error(`Module "${m.key}" depends on unknown module "${dep}"`);
      visit(d, [...trail, m.key]);
    }
    state.set(m.key, 'done');
    out.push(m);
  };
  for (const m of manifests) visit(m, []);
  return out;
}

/** What a module's `web_entry` default-exports. Routes render under /m/<key>/. */
export interface WebModule<Element = unknown> {
  key: string;
  routes: { path: string; element: Element }[];
  /**
   * Pages for people who are not users (customers), rendered without the app shell or a staff session
   * under /p/<key>/. The module's API must authenticate these callers itself.
   */
  publicRoutes?: { path: string; element: Element }[];
  /** Renderers for this module's dashboard widgets, keyed by widget type (`<key>.<name>`). */
  widgets?: Record<string, (props: { data: unknown }) => Element>;
  /**
   * Record-page tabs (`record_panels`) and top-bar side panels (`shell_panels`), keyed by panel key.
   * Side panels get the record on screen, if any (`entity` and `uuid` are empty otherwise).
   */
  panels?: Record<string, (props: { entity: string; uuid: string }) => Element>;
}
