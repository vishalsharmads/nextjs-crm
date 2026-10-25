import fs from 'node:fs';
import path from 'node:path';
import type { Knex } from 'knex';
import { blueprintForIndustry, industryForBlueprint, listBlueprintKeys } from '@app/blueprints';
import { env, isTest } from '../config/env';
import { createKnex, databaseExists, db, ensureDatabase } from '../db/knex';
import { migrateCore } from '../db/migrate';
import { hashPassword, validatePassword } from '../core/auth/auth.service';
import { clearSettingsCache } from '../core/settings/settings.service';
import { newUuid } from '../lib/ids';
import { installCore, markInstalled } from './install';

export const DEMO_PASSWORD = 'DemoAccess2026!';

/** Settings row that marks a database as a demo created by `demo:reset`. Only such databases are wiped. */
const DEMO_KEY = 'demo';

export interface DemoAccount {
  label: string;
  email: string;
  password: string;
}

/**
 * Create (or refresh) one demo user per role and store them for the sign-in screen, which shows them
 * only while DEMO_MODE=true.
 */
export async function seedDemoUsers(
  conn: Knex,
  opts: { password?: string; domain?: string; roles?: string[] } = {},
): Promise<DemoAccount[]> {
  const password = opts.password ?? DEMO_PASSWORD;
  await validatePassword(password);
  const domain = (opts.domain ?? 'demo.test').toLowerCase();
  const roles = await conn('roles')
    .modify((q) => (opts.roles ? q.whereIn('key', opts.roles) : q))
    .orderBy('id')
    .select('id', 'key', 'name');
  if (!roles.length) throw new Error('No matching roles. Apply a blueprint first.');
  const hash = await hashPassword(password);
  const accounts: DemoAccount[] = [];
  for (const role of roles) {
    const email = `demo.${String(role.key).replace(/_/g, '-')}@${domain}`;
    const existing = await conn('users').where({ email }).first('id');
    let id = existing?.id as number | undefined;
    if (id) {
      await conn('users').where({ id }).update({
        password_hash: hash,
        status: 'active',
        failed_login_count: 0,
        locked_until: null,
        deleted_at: null,
      });
    } else {
      [id] = await conn('users').insert({
        uuid: newUuid(),
        email,
        first_name: 'Demo',
        last_name: role.name,
        status: 'active',
        password_hash: hash,
      });
    }
    await conn('user_roles').where({ user_id: id }).delete();
    await conn('user_roles').insert({ user_id: id, role_id: role.id });
    accounts.push({ label: role.name as string, email, password });
  }
  await conn('settings')
    .insert({ key: 'demo_login', group: 'system', value: JSON.stringify({ accounts }), is_public: false })
    .onConflict('key')
    .merge();
  clearSettingsCache();
  return accounts;
}

export class DemoResetRefused extends Error {}

const databaseName = (url: string) => new URL(url).pathname.slice(1);

/**
 * Every condition that must hold before a demo database may be wiped. Throws DemoResetRefused with a
 * plain reason; nothing has been changed when it throws.
 */
export async function assertDemoResetAllowed(url: string, industry: string): Promise<{ blueprint: string }> {
  if (isTest) throw new DemoResetRefused('demo:reset does not run under NODE_ENV=test.');
  if (!env.DEMO_MODE)
    throw new DemoResetRefused(
      'demo:reset only runs on a demo server: set DEMO_MODE=true for this instance.',
    );
  const name = databaseName(url);
  if (!/^[A-Za-z0-9_]*demo[A-Za-z0-9_]*$/i.test(name))
    throw new DemoResetRefused(
      `Database "${name}" is not a demo database. demo:reset only wipes databases whose name contains "demo" (e.g. crm_demo).`,
    );
  // Uploaded files are wiped too, so the upload folder must be the demo's own (default ./storage is shared).
  const storage = path.resolve(env.STORAGE_DIR);
  if (!/demo/i.test(storage))
    throw new DemoResetRefused(
      `Upload folder "${storage}" is not a demo folder. Set STORAGE_DIR to a folder whose path contains "demo" (e.g. ./storage-demo).`,
    );
  const blueprint = blueprintForIndustry(industry);
  if (!listBlueprintKeys().includes(blueprint))
    throw new DemoResetRefused(
      `Unknown industry "${industry}". Available: ${listBlueprintKeys()
        .map(industryForBlueprint)
        .join(', ')}`,
    );

  // An existing database may only be wiped if a previous demo:reset created it (or it is empty).
  if (!(await databaseExists(url))) return { blueprint };
  const check = createKnex(url, { poolMax: 1 });
  try {
    const tables = (await check
      .select('table_name as name')
      .from('information_schema.tables')
      .whereRaw('table_schema = DATABASE()')) as { name: string }[];
    if (tables.length) {
      const marker = tables.some((t) => t.name === 'settings')
        ? await check('settings').where({ key: DEMO_KEY }).first('key')
        : null;
      if (!marker)
        throw new DemoResetRefused(
          `Database "${name}" has data that demo:reset did not create. It never wipes such a database; ` +
            'point DATABASE_URL at an empty demo database instead.',
        );
    }
  } finally {
    await check.destroy();
  }
  return { blueprint };
}

/**
 * Drop every table and view, keeping the database itself (shared hosts rarely allow CREATE DATABASE).
 * Returns null when the database does not exist yet.
 */
async function emptyDatabase(url: string): Promise<number | null> {
  if (!(await databaseExists(url))) return null;
  const conn = createKnex(url, { poolMax: 1 });
  try {
    const rows = (await conn
      .select('table_name as name', 'table_type as type')
      .from('information_schema.tables')
      .whereRaw('table_schema = DATABASE()')) as { name: string; type: string }[];
    await conn.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const r of rows) {
      await conn.raw(r.type === 'VIEW' ? 'DROP VIEW IF EXISTS ??' : 'DROP TABLE IF EXISTS ??', [r.name]);
    }
    await conn.raw('SET FOREIGN_KEY_CHECKS = 1');
    return rows.length;
  } finally {
    await conn.destroy();
  }
}

/** Remove uploaded files (their rows are gone). Only the contents of the configured folder. */
function emptyStorage(dir: string): void {
  const root = path.resolve(dir);
  if (root === path.parse(root).root) throw new DemoResetRefused(`Refusing to empty "${root}"`);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root))
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
}

/**
 * Wipe the demo database and install one industry with sample data and one demo user per role.
 * Call `assertDemoResetAllowed` first.
 */
export async function resetDemo(
  opts: { url: string; blueprint: string; password?: string },
  out: (msg: string) => void,
): Promise<DemoAccount[]> {
  const password = opts.password ?? DEMO_PASSWORD;
  out('1/5  Emptying the demo database and uploaded files');
  const dropped = await emptyDatabase(opts.url);
  emptyStorage(env.STORAGE_DIR);
  // Create it only when missing: hosting accounts often may not create databases at all.
  if (dropped === null) await ensureDatabase(opts.url);
  out(dropped === null ? '     Created the database' : `     ${dropped} tables removed`);

  out('2/5  Running migrations');
  await migrateCore(db);
  // Mark it as a demo straight away, so a failed install can still be reset.
  await db('settings')
    .insert({
      key: DEMO_KEY,
      group: 'system',
      value: JSON.stringify({ blueprint: opts.blueprint }),
      is_public: false,
    })
    .onConflict('key')
    .merge();

  out('3/5  Installing core configuration');
  await installCore(db, {
    adminEmail: 'admin@demo.test',
    adminPassword: password,
    adminFirstName: 'Demo',
    adminLastName: 'Admin',
  });

  out(`4/5  Applying "${opts.blueprint}" with sample data`);
  const { applyBlueprintByKey } = await import('../blueprints/applier');
  const report = await applyBlueprintByKey(db, opts.blueprint, { sampleData: true });
  out(`     ${report.summary}`);
  for (const w of report.warnings) out(`     note: ${w}`);
  await markInstalled(db, opts.blueprint);
  await db('settings')
    .where({ key: DEMO_KEY })
    .update({
      value: JSON.stringify({
        blueprint: opts.blueprint,
        industry: industryForBlueprint(opts.blueprint),
        resetAt: new Date().toISOString(),
      }),
    });

  out('5/5  Creating demo users');
  return seedDemoUsers(db, { password });
}
