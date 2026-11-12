import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS, SETTINGS_GROUPS, SETTINGS_HELP } from '@app/shared';
import { HELP_ARTICLES, articleForPath, parseArticle, routeMatches } from './registry';
import { TOURS } from './tours';

/**
 * Drift guard: help ships with the feature. A new page, setting or module without help, or help
 * that points at something that no longer exists, fails here.
 */
// Tests run from apps/web.
const router = readFileSync(path.resolve('src/app/router.tsx'), 'utf8');
const manifests = import.meta.glob<{
  key: string;
  permissions?: { key: string }[];
  menu_items?: { path: string }[];
  settings?: { key: string; help?: string }[];
}>('../../../../modules/*/manifest.json', { import: 'default', eager: true });

const settingsBlock = router.slice(
  router.indexOf('const settingsPages'),
  router.indexOf('];', router.indexOf('const settingsPages')),
);
const settingsPaths = [...settingsBlock.matchAll(/path: '([a-z-]+)'/g)].map((m) => `/settings/${m[1]}`);
const shellBlock = router.slice(router.indexOf('element: <AppShell />'));
const shellPaths = [...shellBlock.matchAll(/\{ (?:index: true|path: '([^']+)')/g)]
  .map((m) => (m[1] === undefined ? '/' : `/${m[1]}`))
  .filter((p) => !['/*', '/settings', '/m/:moduleKey/*'].includes(p));
const permissions = new Set([
  ...CORE_PERMISSIONS.map((p) => p.key),
  ...Object.values(manifests).flatMap((m) => (m.permissions ?? []).map((p) => p.key)),
]);
const ids = new Set(HELP_ARTICLES.map((a) => a.id));

describe('help articles', () => {
  it('have unique ids', () => {
    expect(ids.size).toBe(HELP_ARTICLES.length);
  });

  it('cover every settings page', () => {
    expect(settingsPaths.length).toBeGreaterThan(20);
    expect(settingsPaths.filter((p) => !articleForPath(p))).toEqual([]);
  });

  it('cover every page of the app', () => {
    const sample = (p: string) =>
      p.replace(/:[a-zA-Z]+/g, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b').replace('/*', '/x');
    expect(shellPaths.length).toBeGreaterThan(10);
    expect(shellPaths.filter((p) => !articleForPath(sample(p)))).toEqual([]);
  });

  it('cover every module page', () => {
    const missing = Object.values(manifests)
      .flatMap((m) => m.menu_items ?? [])
      .filter((i) => !articleForPath(i.path));
    expect(missing).toEqual([]);
  });

  it('name real permissions and related articles', () => {
    for (const a of HELP_ARTICLES) {
      if (a.permission && a.permission !== 'admin')
        expect(permissions.has(a.permission), `${a.id}: ${a.permission}`).toBe(true);
      for (const r of a.related) expect(ids.has(r), `${a.id} → ${r}`).toBe(true);
    }
  });

  it('only generate tables from things that exist', () => {
    for (const a of HELP_ARTICLES)
      for (const m of a.html.matchAll(/<!--\s*generated:([a-z-]+)(?::([a-z0-9_.-]+))?\s*-->/g)) {
        const [, kind, arg] = m;
        if (kind === 'settings') expect(arg! in SETTINGS_GROUPS, `${a.id}: settings:${arg}`).toBe(true);
        else if (kind === 'permissions')
          expect(
            [...permissions].some((p) => p.startsWith(arg ?? '')),
            `${a.id}: permissions:${arg}`,
          ).toBe(true);
        else if (kind === 'module-settings')
          expect(
            Object.values(manifests).some((mf) => mf.key === arg && (mf.settings ?? []).length > 0),
            `${a.id}: module-settings:${arg}`,
          ).toBe(true);
        else expect(kind, a.id).toBe('tools');
      }
  });

  it('list the settings of every module that has some', () => {
    for (const m of Object.values(manifests)) {
      if (!(m.settings ?? []).length) continue;
      for (const f of m.settings!) expect(f.help, `${m.key}.${f.key} has no help`).toBeTruthy();
      expect(
        HELP_ARTICLES.some((a) => a.html.includes(`generated:module-settings:${m.key}`)),
        `${m.key}: add <!-- generated:module-settings:${m.key} --> to its help article`,
      ).toBe(true);
    }
  });

  it('describe every setting of every group', () => {
    for (const group of Object.keys(SETTINGS_GROUPS) as (keyof typeof SETTINGS_GROUPS)[]) {
      const keys = Object.keys(SETTINGS_GROUPS[group].shape);
      expect(Object.keys(SETTINGS_HELP[group]).sort(), group).toEqual(keys.sort());
    }
  });

  it('never name a vendor', () => {
    const deny = readFileSync(path.resolve('../../brand-denylist.txt'), 'utf8')
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#'));
    for (const a of HELP_ARTICLES)
      for (const word of deny)
        expect(`${a.title} ${a.text}`.toLowerCase().includes(word), `${a.id}: ${word}`).toBe(false);
  });
});

describe('guided tours', () => {
  // Every `data-tour` target in the web app and modules.
  const sources = {
    ...import.meta.glob<string>('../**/*.tsx', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob<string>('../../../../modules/*/web/**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  };
  const targets = new Set(
    Object.values(sources).flatMap((src) => [...src.matchAll(/data-tour="([a-z0-9-]+)"/g)].map((m) => m[1]!)),
  );

  it('point at elements that exist, on pages that have help', () => {
    expect(new Set(TOURS.map((t) => t.id)).size).toBe(TOURS.length);
    for (const t of TOURS) {
      expect(articleForPath(t.route), t.id).toBeTruthy();
      if (t.permission) expect(permissions.has(t.permission), `${t.id}: ${t.permission}`).toBe(true);
      for (const step of t.steps) expect(targets.has(step.target), `${t.id}: ${step.target}`).toBe(true);
    }
  });
});

describe('help routing', () => {
  it('matches exact, parameter and wildcard routes, preferring the most specific', () => {
    expect(routeMatches('/deals/:uuid', '/deals/abc')).toBe(true);
    expect(routeMatches('/deals/:uuid', '/deals')).toBe(false);
    expect(routeMatches('/o/*', '/o/vehicle/abc')).toBe(true);
    const a = parseArticle('---\nid: a\ntitle: A\nroute: /m/x/*\n---\nA', 'a.md');
    const b = parseArticle('---\nid: b\ntitle: B\nroute: /m/x/settings\n---\nB', 'b.md');
    expect(articleForPath('/m/x/settings', [a, b])?.id).toBe('b');
    expect(articleForPath('/m/x/other', [a, b])?.id).toBe('a');
  });
});
