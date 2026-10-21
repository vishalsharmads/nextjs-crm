import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getApp } from './helpers';
import { routeRegistry } from '../src/http/routes';
import { installedModuleSources } from '../src/modules/installed';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  name?: string;
}

function collectRoutes(app: Express) {
  const out: { method: string; path: string }[] = [];
  const walk = (stack: Layer[]) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m, path: layer.route.path });
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((app as unknown as { router: { stack: Layer[] } }).router.stack);
  return out;
}

describe('route permissions', () => {
  it('every mounted route is registered with a declared permission', async () => {
    const app = await getApp();
    const mounted = collectRoutes(app).filter((r) => r.path !== '/api/v1/health');
    expect(mounted.length).toBeGreaterThan(20);
    const missing = mounted.filter(
      (r) => !routeRegistry.some((reg) => reg.method === r.method && reg.path === r.path),
    );
    expect(missing).toEqual([]);
    for (const reg of routeRegistry) {
      expect(reg.permission, `${reg.method} ${reg.path}`).toBeTruthy();
    }
  });

  it('public routes are limited to an explicit allow-list', () => {
    const publicRoutes = routeRegistry
      .filter((r) => r.permission === 'public')
      .map((r) => `${r.method} ${r.path}`);
    const allowed = [/^\S+ \/public\//, /^\S+ \/auth\//, /^post \/forms\/[^/]+\/submit$/];
    const unexpected = publicRoutes.filter((r) => !allowed.some((re) => re.test(r)));
    expect(unexpected).toEqual([]);
  });

  it('no route is shadowed by an earlier route with a path parameter', async () => {
    await getApp();
    const toRe = (path: string) => new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
    const shadowed: string[] = [];
    routeRegistry.forEach((r, i) => {
      const earlier = routeRegistry
        .slice(0, i)
        .find((e) => e.method === r.method && e.path !== r.path && toRe(e.path).test(r.path));
      if (earlier) shadowed.push(`${r.method} ${r.path} (shadowed by ${earlier.path})`);
    });
    expect(shadowed).toEqual([]);
  });

  it('every module manifest in /modules is compiled into the build', () => {
    const dir = path.resolve(__dirname, '../../../modules');
    const keys = readdirSync(dir).filter((k) => existsSync(path.join(dir, k, 'manifest.json')));
    const installed = installedModuleSources.map((s) => (s.manifest as { key: string }).key);
    expect(installed.sort()).toEqual(keys.sort());
  });
});
