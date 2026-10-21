import { parseArgs } from 'node:util';
import { passwordPolicySchema, securitySettingsSchema } from '@app/shared';
import { env } from '../config/env';
import { db, ensureDatabase } from '../db/knex';
import { migrateCore, rollbackCore } from '../db/migrate';
import { installCore, markInstalled } from './install';
import { runDoctor } from './doctor';
import { hashPassword, validatePassword } from '../core/auth/auth.service';
import { randomToken } from '../lib/crypto';
import { newUuid } from '../lib/ids';
import { clearSettingsCache } from '../core/settings/settings.service';

type Command = (args: string[]) => Promise<void>;

const out = (msg: string) => process.stdout.write(`${msg}\n`);

const commands: Record<string, Command> = {
  async 'db:migrate'() {
    await ensureDatabase(env.DATABASE_URL);
    const applied = await migrateCore(db);
    out(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date');
  },

  async 'db:rollback'() {
    const rolled = await rollbackCore(db);
    out(rolled.length ? `Rolled back: ${rolled.join(', ')}` : 'Nothing to roll back');
  },

  async install(args) {
    const { values } = parseArgs({
      args,
      options: {
        blueprint: { type: 'string', default: 'generic' },
        'app-name': { type: 'string' },
        'admin-email': { type: 'string' },
        'admin-password': { type: 'string' },
        'admin-name': { type: 'string' },
        'sample-data': { type: 'boolean', default: false },
      },
    });
    const adminEmail = values['admin-email'] ?? process.env.ADMIN_EMAIL;
    if (!adminEmail) throw new Error('Pass --admin-email=<email> (or set ADMIN_EMAIL)');
    const adminPassword = values['admin-password'] ?? process.env.ADMIN_PASSWORD;
    if (adminPassword) {
      const policy = passwordPolicySchema(securitySettingsSchema.parse({})).safeParse(adminPassword);
      if (!policy.success) throw new Error(`Admin password: ${policy.error.issues[0]?.message}`);
    }

    out('1/4  Checking database');
    await ensureDatabase(env.DATABASE_URL);
    out('2/4  Running migrations');
    await migrateCore(db);

    out('3/4  Seeding core configuration');
    const [first, ...rest] = (values['admin-name'] ?? 'Admin').split(' ');
    const admin = await installCore(db, {
      appName: values['app-name'],
      adminEmail,
      adminPassword,
      adminFirstName: first,
      adminLastName: rest.join(' '),
    });

    out(`4/4  Applying blueprint "${values.blueprint}"`);
    const { applyBlueprintByKey } = await import('../blueprints/applier');
    const report = await applyBlueprintByKey(db, values.blueprint!, { sampleData: values['sample-data'] });
    out(`     ${report.summary}`);
    for (const w of report.warnings) out(`     note: ${w}`);
    for (const c of report.conflicts) out(`     conflict: ${c.item} (${c.message})`);
    await markInstalled(db, values.blueprint!);
    clearSettingsCache();

    out('');
    out(admin.created ? `Admin user created: ${admin.email}` : `Admin user already existed: ${admin.email}`);
    if (admin.generatedPassword)
      out(`Temporary password: ${admin.generatedPassword}  (change it after signing in)`);
    out('Install complete.');
  },

  async 'blueprint:apply'(args) {
    const { values } = parseArgs({
      args,
      options: {
        blueprint: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
      },
    });
    if (!values.blueprint) throw new Error('Pass --blueprint=<key>');
    const { applyBlueprintByKey } = await import('../blueprints/applier');
    const report = await applyBlueprintByKey(db, values.blueprint, {
      dryRun: values['dry-run'],
      force: values.force,
    });
    out(JSON.stringify(report, null, 2));
  },

  async 'blueprint:export'(args) {
    const { values } = parseArgs({
      args,
      options: { out: { type: 'string' }, key: { type: 'string' }, version: { type: 'string' } },
    });
    const { exportBlueprint } = await import('../blueprints/exporter');
    const json = JSON.stringify(
      await exportBlueprint(db, { key: values.key, version: values.version }),
      null,
      2,
    );
    if (values.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(values.out, `${json}\n`);
      out(`Wrote ${values.out}`);
    } else {
      out(json);
    }
  },

  /**
   * Create (or refresh) one demo user per role and store them for the sign-in screen.
   * They only show while DEMO_MODE=true. Never run this on a client instance.
   */
  async 'demo:seed'(args) {
    const { values } = parseArgs({
      args,
      options: { password: { type: 'string' }, domain: { type: 'string' }, roles: { type: 'string' } },
    });
    const password = values.password ?? 'DemoAccess2026!';
    await validatePassword(password);
    const domain = (values.domain ?? 'demo.test').toLowerCase();
    const wanted = values.roles?.split(',').map((r) => r.trim());
    const roles = await db('roles')
      .modify((q) => (wanted ? q.whereIn('key', wanted) : q))
      .orderBy('id')
      .select('id', 'key', 'name');
    if (!roles.length) throw new Error('No matching roles. Apply a blueprint first.');
    const hash = await hashPassword(password);
    const accounts: { label: string; email: string; password: string }[] = [];
    for (const role of roles) {
      const email = `demo.${String(role.key).replace(/_/g, '-')}@${domain}`;
      const existing = await db('users').where({ email }).first('id');
      let id = existing?.id as number | undefined;
      if (id) {
        await db('users')
          .where({ id })
          .update({
            password_hash: hash,
            status: 'active',
            failed_login_count: 0,
            locked_until: null,
            deleted_at: null,
          });
      } else {
        [id] = await db('users').insert({
          uuid: newUuid(),
          email,
          first_name: 'Demo',
          last_name: role.name,
          status: 'active',
          password_hash: hash,
        });
      }
      await db('user_roles').where({ user_id: id }).delete();
      await db('user_roles').insert({ user_id: id, role_id: role.id });
      accounts.push({ label: role.name as string, email, password });
    }
    await db('settings')
      .insert({ key: 'demo_login', group: 'system', value: JSON.stringify({ accounts }), is_public: false })
      .onConflict('key')
      .merge();
    clearSettingsCache();
    for (const a of accounts) out(`${a.label.padEnd(24)} ${a.email}`);
    out(`Password for all: ${password}`);
    out(
      env.DEMO_MODE
        ? 'Shown on the sign-in screen (DEMO_MODE=true).'
        : 'Hidden until you set DEMO_MODE=true in .env and restart the API.',
    );
  },

  /** Show one existing account on the sign-in screen (while DEMO_MODE=true). */
  async 'demo:enable'(args) {
    const { values } = parseArgs({
      args,
      options: { email: { type: 'string' }, password: { type: 'string' }, label: { type: 'string' } },
    });
    if (!values.email || !values.password)
      throw new Error('Pass --email and --password of an existing account');
    const user = await db('users').where({ email: values.email.toLowerCase() }).first('id');
    if (!user) throw new Error('No user with that email');
    const accounts = [
      { label: values.label ?? 'Admin', email: values.email.toLowerCase(), password: values.password },
    ];
    await db('settings')
      .insert({ key: 'demo_login', group: 'system', value: JSON.stringify({ accounts }), is_public: false })
      .onConflict('key')
      .merge();
    clearSettingsCache();
    out(
      env.DEMO_MODE
        ? 'Demo sign-in details will show on the sign-in screen. Never enable this on a client instance.'
        : 'Saved. Set DEMO_MODE=true in .env and restart the API to show it.',
    );
  },

  async 'demo:disable'() {
    await db('settings').where({ key: 'demo_login' }).delete();
    out('Demo sign-in details removed. Demo users still exist; disable them in Settings → People if needed.');
  },

  async doctor() {
    const ok = await runDoctor(out);
    if (!ok) process.exitCode = 1;
  },

  async 'user:reset-password'(args) {
    const { values } = parseArgs({
      args,
      options: { email: { type: 'string' }, password: { type: 'string' } },
    });
    if (!values.email) throw new Error('Pass --email=<email>');
    const password = values.password ?? `${randomToken(12)}Aa1`;
    if (values.password) await validatePassword(password);
    const n = await db('users')
      .where({ email: values.email.toLowerCase() })
      .update({
        password_hash: await hashPassword(password),
        failed_login_count: 0,
        locked_until: null,
        status: 'active',
      });
    if (!n) throw new Error('No user with that email');
    out(values.password ? 'Password updated.' : `New password: ${password}`);
  },
};

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    out(`Usage: cli <command>\nCommands: ${Object.keys(commands).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  try {
    await cmd(args);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

await main();
