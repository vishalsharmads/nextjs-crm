import { z } from 'zod';
import { PERMISSION_KEY_RE } from '@app/shared';

export const MODULE_KEY_RE = /^[a-z][a-z0-9-]{1,63}$/;

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
    settings_schema: z.record(z.string(), z.unknown()).default({}),
    migrations_dir: z.string().optional(),
    api_entry: z.string().optional(),
    web_entry: z.string().optional(),
    labels: z
      .record(
        z.string(),
        z.object({ singular: z.string().min(1).max(60), plural: z.string().min(1).max(60) }),
      )
      .default({}),
    dashboard_widgets: z
      .array(
        z.object({ type: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9_.-]+$/), title: z.string().max(100) }),
      )
      .default([]),
  })
  .superRefine((m, ctx) => {
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
}
