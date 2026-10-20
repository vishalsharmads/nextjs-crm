import { parseArgs } from 'node:util';
import { passwordPolicySchema, securitySettingsSchema } from '@app/shared';
import { env } from '../config/env';
import { db, ensureDatabase } from '../db/knex';
import { migrateCore, rollbackCore } from '../db/migrate';
import { installCore, markInstalled } from './install';
import { runDoctor } from './doctor';
import { hashPassword, validatePassword } from '../core/auth/auth.service';
import { randomToken } from '../lib/crypto';
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
