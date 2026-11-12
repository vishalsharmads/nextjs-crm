import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { clientWithRoles } from './helpers';
import { env } from '../src/config/env';
import { clearCatalogCache } from '../src/modules/catalog';
import { addCatalogModule } from '../src/cli/module-add';
import { checkModuleFolder } from '../src/cli/module-check';

const repoRoot = resolve(__dirname, '../../..');
const sha = 'a'.repeat(40);
let server: Server;
let catalogBody = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer cat-token') {
      res.statusCode = 401;
      return res.end();
    }
    res.setHeader('content-type', 'application/json');
    res.end(catalogBody);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});

afterAll(() => {
  server.close();
  env.MODULE_CATALOG_URL = undefined;
  env.MODULE_CATALOG_TOKEN = undefined;
  clearCatalogCache();
});

const entry = (over: Record<string, unknown>) => ({
  description: 'From the catalog',
  category: 'integration',
  repo: 'https://code.example.com/acme/x.git',
  tag: 'v1.0.0',
  sha,
  ...over,
});

describe('module catalog', () => {
  it('says when no catalog is set up', async () => {
    const { client } = await clientWithRoles(['admin']);
    env.MODULE_CATALOG_URL = undefined;
    clearCatalogCache();
    expect((await client.get('/modules/catalog').expect(200)).body).toEqual({ configured: false, data: [] });
  });

  it('lists catalog modules against this build, with the read token', async () => {
    const { client } = await clientWithRoles(['admin']);
    catalogBody = JSON.stringify({
      modules: [
        entry({ key: 'fleet', name: 'Fleet', version: '1.2.0' }),
        entry({ key: 'notes-demo', name: 'Pinned notes', version: '9.0.0' }),
        entry({ key: 'bookings', name: 'Bookings', version: '0.0.1' }),
      ],
    });
    env.MODULE_CATALOG_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/catalog.json`;
    env.MODULE_CATALOG_TOKEN = 'cat-token';
    clearCatalogCache();
    const res = await client.get('/modules/catalog').expect(200);
    expect(res.body.configured).toBe(true);
    const byKey = Object.fromEntries(res.body.data.map((e: { key: string }) => [e.key, e]));
    expect(byKey.fleet).toMatchObject({
      installed: false,
      updateAvailable: false,
      command: 'npm run module:add -- fleet',
    });
    expect(byKey['notes-demo']).toMatchObject({ installed: true, updateAvailable: true });
    expect(byKey.bookings).toMatchObject({ installed: true, updateAvailable: false });
    expect(JSON.stringify(res.body)).not.toContain('code.example.com');
  });

  it('reports an unreadable catalog without its details', async () => {
    const { client } = await clientWithRoles(['admin']);
    env.MODULE_CATALOG_TOKEN = 'wrong';
    clearCatalogCache();
    const res = await client.get('/modules/catalog');
    expect(res.body.error).toMatchObject({ code: 'UPSTREAM_FAILED' });
    env.MODULE_CATALOG_TOKEN = 'cat-token';
    catalogBody = '{"modules": "nope"}';
    clearCatalogCache();
    expect((await client.get('/modules/catalog')).body.error.message).toContain('expected format');
  });
});

describe('module:add', () => {
  let work = '';
  let root = '';
  let repo = '';
  let head = '';

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'catalog-test-'));
    // A pretend checkout: the brand list, an installed.ts and an empty modules folder.
    root = join(work, 'checkout');
    mkdirSync(join(root, 'modules'), { recursive: true });
    mkdirSync(join(root, 'apps/api/src/modules'), { recursive: true });
    cpSync(join(repoRoot, 'brand-denylist.txt'), join(root, 'brand-denylist.txt'));
    writeFileSync(
      join(root, 'apps/api/src/modules/installed.ts'),
      "import type { InstalledModuleSource } from './types';\n\nexport const installedModuleSources: InstalledModuleSource[] = [\n];\n",
    );
    // A module repository with the module under modules/fleet-log.
    repo = join(work, 'repo');
    cpSync(join(repoRoot, 'modules/notes-demo'), join(repo, 'pkg'), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(repo, 'pkg/manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(repo, 'pkg/manifest.json'),
      JSON.stringify({
        ...manifest,
        key: 'fleet-log',
        permissions: [],
        menu_items: [],
        dashboard_widgets: [],
      }),
    );
    const migration = join(repo, 'pkg/api/migrations/0001_notes.ts');
    writeFileSync(migration, readFileSync(migration, 'utf8').replaceAll('m_notes_demo_', 'm_fleet_log_'));
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
    git(repo, 'tag', 'v1.0.0');
    head = git(repo, 'rev-parse', 'HEAD');
  });

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const catalogEntry = (over: Record<string, unknown> = {}) =>
    ({
      key: 'fleet-log',
      name: 'Fleet log',
      version: '1.0.0',
      description: '',
      category: 'integration',
      repo,
      tag: 'v1.0.0',
      sha: head,
      path: 'pkg',
      ...over,
    }) as Parameters<typeof addCatalogModule>[0]['entry'];

  it('refuses a tag that no longer points at the pinned commit', () => {
    expect(() => addCatalogModule({ root, entry: catalogEntry({ sha: 'b'.repeat(40) }) })).toThrow(/pinned/);
    expect(existsSync(join(root, 'modules/fleet-log'))).toBe(false);
  });

  it('refuses a module that breaks the rules, and adds nothing', () => {
    const { problems } = addCatalogModule({ root, entry: catalogEntry({ key: 'other-key' }) });
    expect(problems.join('\n')).toContain('does not match the folder');
    expect(existsSync(join(root, 'modules/other-key'))).toBe(false);
  });

  it('copies the pinned commit and registers it, for review', () => {
    const { problems } = addCatalogModule({ root, entry: catalogEntry() });
    expect(problems).toEqual([]);
    expect(existsSync(join(root, 'modules/fleet-log/manifest.json'))).toBe(true);
    expect(existsSync(join(root, 'modules/fleet-log/.git'))).toBe(false);
    expect(readFileSync(join(root, 'apps/api/src/modules/installed.ts'), 'utf8')).toContain(
      "modules/fleet-log/manifest.json'",
    );
    expect(() => addCatalogModule({ root, entry: catalogEntry() })).toThrow(/already exists/);
  });
});

describe('module checks', () => {
  it('passes every module in this repository', () => {
    for (const key of ['notes-demo', 'records-demo', 'assistant', 'portal', 'invoices'])
      expect(checkModuleFolder(repoRoot, join(repoRoot, 'modules', key)), key).toEqual([]);
  });

  it('flags tables, imports and brand names that break the rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-module-'));
    const mod = join(dir, 'modules', 'bad-mod');
    mkdirSync(join(mod, 'api/migrations'), { recursive: true });
    writeFileSync(
      join(mod, 'manifest.json'),
      JSON.stringify({ key: 'bad-mod', name: 'Bad', version: '1.0.0' }),
    );
    writeFileSync(
      join(mod, 'api/index.ts'),
      "import { db } from '@app/api/src/db/knex';\nimport { exec } from 'node:child_process';\nexport const x = eval('1');\n",
    );
    writeFileSync(join(mod, 'api/migrations/0001.ts'), "knex.schema.createTable('contacts', () => {});\n");
    const problems = checkModuleFolder(repoRoot, mod).join('\n');
    rmSync(dir, { recursive: true, force: true });
    expect(problems).toContain('may only import "@app/api/module-api"');
    expect(problems).toContain('child_process');
    expect(problems).toContain('eval');
    expect(problems).toContain('table "contacts" must start with "m_bad_mod_"');
    expect(problems).toContain('help article');
  });
});
