import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knexFactory, { type Knex } from 'knex';

const run = promisify(execFile);

/**
 * demo:reset wipes a database, so it is exercised as the real CLI in a child process against its own
 * databases (never crm_test), with NODE_ENV=development because the command refuses to run under test.
 */
const base = new URL(process.env.DATABASE_URL_TEST ?? 'mysql://root@127.0.0.1:3306/crm_test');
const urlFor = (name: string) => Object.assign(new URL(base.toString()), { pathname: `/${name}` }).toString();
const DEMO_DB = 'crm_test_demo';
const OTHER_DB = 'crm_test_other';

let server: Knex;
let storage: string;

async function reset(industry: string, env: Record<string, string> = {}) {
  try {
    const r = await run('npx', ['tsx', 'src/cli/index.ts', 'demo:reset', `--industry=${industry}`, '--yes'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LOG_LEVEL: 'silent',
        DEMO_MODE: 'true',
        STORAGE_DIR: storage,
        DATABASE_URL: urlFor(DEMO_DB),
        ...env,
      },
    });
    return { ok: true, out: r.stdout };
  } catch (err) {
    const e = err as { stdout: string; stderr: string };
    return { ok: false, out: `${e.stdout}${e.stderr}` };
  }
}

const exists = async (name: string) =>
  !!(await server('information_schema.schemata').where('schema_name', name).first('schema_name'));

describe('demo:reset', () => {
  beforeAll(async () => {
    server = knexFactory({
      client: 'mysql2',
      connection: {
        host: base.hostname,
        port: Number(base.port || 3306),
        user: decodeURIComponent(base.username),
        password: decodeURIComponent(base.password),
      },
    });
    for (const db of [DEMO_DB, OTHER_DB]) await server.raw('DROP DATABASE IF EXISTS ??', [db]);
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-demo-'));
  });

  afterAll(async () => {
    for (const db of [DEMO_DB, OTHER_DB]) await server.raw('DROP DATABASE IF EXISTS ??', [db]);
    await server.destroy();
  });

  it('refuses without DEMO_MODE and creates nothing', async () => {
    const r = await reset('coworking', { DEMO_MODE: 'false' });
    expect(r.ok).toBe(false);
    expect(r.out).toContain('DEMO_MODE=true');
    expect(await exists(DEMO_DB)).toBe(false);
  });

  it('refuses a database whose name does not say demo', async () => {
    const r = await reset('coworking', { DATABASE_URL: urlFor(OTHER_DB) });
    expect(r.ok).toBe(false);
    expect(r.out).toContain('not a demo database');
    expect(await exists(OTHER_DB)).toBe(false);
  });

  it('refuses an upload folder that is not the demo’s own', async () => {
    const r = await reset('coworking', { STORAGE_DIR: os.tmpdir() });
    expect(r.ok).toBe(false);
    expect(r.out).toContain('not a demo folder');
  });

  it('installs an industry with sample data and demo users, then switches to another', async () => {
    fs.writeFileSync(path.join(storage, 'old-upload.bin'), 'x');
    const first = await reset('coworking');
    expect(first.ok, first.out).toBe(true);
    expect(first.out).toContain('demo.community-manager@demo.test');
    expect(fs.readdirSync(storage)).toEqual([]);

    const demo = knexFactory({ client: 'mysql2', connection: urlFor(DEMO_DB) });
    try {
      expect((await demo('contacts').count('* as n').first())?.n).toBeGreaterThan(0);
      const marker = (await demo('settings').where({ key: 'demo' }).first('value'))?.value;
      expect(marker).toMatchObject({ blueprint: 'coworking', industry: 'coworking' });

      const second = await reset('immigration-visa');
      expect(second.ok, second.out).toBe(true);
      expect(await demo('blueprint_applications').pluck('blueprint_key')).toEqual(['visa-consultancy']);
      const switched = (await demo('settings').where({ key: 'demo' }).first('value'))?.value;
      expect(switched).toMatchObject({ blueprint: 'visa-consultancy', industry: 'immigration-visa' });
      expect(await demo('roles').where({ key: 'community_manager' }).first()).toBeUndefined();
    } finally {
      await demo.destroy();
    }
  }, 120_000);

  it('never wipes a database it did not create', async () => {
    await server.raw('CREATE DATABASE ??', [`${DEMO_DB}_client`]);
    await server.raw('CREATE TABLE ??.contacts (id INT)', [`${DEMO_DB}_client`]);
    try {
      const r = await reset('coworking', { DATABASE_URL: urlFor(`${DEMO_DB}_client`) });
      expect(r.ok).toBe(false);
      expect(r.out).toContain('did not create');
      const tables = await server('information_schema.tables')
        .where('table_schema', `${DEMO_DB}_client`)
        .pluck('TABLE_NAME');
      expect(tables).toEqual(['contacts']);
    } finally {
      await server.raw('DROP DATABASE IF EXISTS ??', [`${DEMO_DB}_client`]);
    }
  });
});
