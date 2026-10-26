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
import { sealPendingDays, verifyIntegrity } from '../core/audit/integrity';
import { anonymizeUser } from '../core/privacy/staff';
import { encryptExistingFiles, rotateKeys } from '../core/security/rotation';
import { systemContext } from '../http/context';

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
    const { seedDemoUsers, DEMO_PASSWORD } = await import('./demo');
    const accounts = await seedDemoUsers(db, {
      password: values.password,
      domain: values.domain,
      roles: values.roles?.split(',').map((r) => r.trim()),
    });
    for (const a of accounts) out(`${a.label.padEnd(24)} ${a.email}`);
    out(`Password for all: ${values.password ?? DEMO_PASSWORD}`);
    out(
      env.DEMO_MODE
        ? 'Shown on the sign-in screen (DEMO_MODE=true).'
        : 'Hidden until you set DEMO_MODE=true in .env and restart the API.',
    );
  },

  /**
   * Wipe the demo database and install one industry with sample data and demo users.
   * Refuses unless DEMO_MODE=true, the database name contains "demo", and the database is empty or was
   * created by an earlier demo:reset. Usage: demo:reset --industry=law-firms [--yes] [--restart-file=tmp/restart.txt]
   */
  async 'demo:reset'(args) {
    const { values } = parseArgs({
      args,
      options: {
        industry: { type: 'string' },
        password: { type: 'string' },
        yes: { type: 'boolean', default: false },
        'restart-file': { type: 'string' },
      },
    });
    if (!values.industry) throw new Error('Pass --industry=<slug>, e.g. --industry=coworking');
    const { assertDemoResetAllowed, resetDemo } = await import('./demo');
    await assertDemoResetAllowed(env.DATABASE_URL, values.industry);
    const name = new URL(env.DATABASE_URL).pathname.slice(1);
    if (!values.yes) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `This deletes everything in "${name}" and its uploaded files. Type the industry (${values.industry}) to continue: `,
      );
      rl.close();
      if (answer.trim() !== values.industry) {
        out('Nothing changed.');
        return;
      }
    }
    const accounts = await resetDemo(
      { url: env.DATABASE_URL, industry: values.industry, password: values.password },
      out,
    );
    out('');
    out(`Demo for "${values.industry}" is ready in "${name}".`);
    for (const a of accounts) out(`  ${a.label.padEnd(24)} ${a.email}`);
    out(`  Password for all: ${accounts[0]?.password}`);
    if (values['restart-file']) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(values['restart-file']), { recursive: true });
      writeFileSync(values['restart-file'], new Date().toISOString());
      out(`Touched ${values['restart-file']}: the app restarts on its next request.`);
    } else {
      out('Restart the app now so it picks up the new industry.');
    }
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

  /**
   * Bulk-insert realistic volume for load testing (organizations, contacts, deals, tasks).
   * Refuses to run in production. Usage: seed:volume --contacts=20000
   */
  async 'seed:volume'(args) {
    if (env.NODE_ENV === 'production') throw new Error('seed:volume never runs in production');
    const { values } = parseArgs({ args, options: { contacts: { type: 'string' } } });
    const total = Math.min(Number(values.contacts ?? 10000), 500_000);
    const owners = (await db('users')
      .where({ status: 'active' })
      .whereNull('deleted_at')
      .pluck('id')) as number[];
    const pipeline = await db('pipelines')
      .where({ entity: 'deal' })
      .orderBy('is_default', 'desc')
      .first('id');
    if (!owners.length || !pipeline)
      throw new Error('Install the instance first (users and a deal pipeline are needed)');
    const stages = (await db('pipeline_stages')
      .where({ pipeline_id: pipeline.id })
      .orderBy('sort_order')
      .pluck('id')) as number[];
    const general = (await db('settings').where({ key: 'general' }).first('value'))?.value as
      { currency?: string } | undefined;
    const currency = general?.currency ?? 'USD';
    const first = [
      'Ada',
      'Ben',
      'Chen',
      'Dara',
      'Eli',
      'Fatima',
      'Gus',
      'Hana',
      'Ivan',
      'Jun',
      'Kofi',
      'Lena',
      'Mo',
      'Noor',
      'Omar',
      'Priya',
    ];
    const last = [
      'Smith',
      'Okafor',
      'Tanaka',
      'Garcia',
      'Novak',
      'Haddad',
      'Silva',
      'Kim',
      'Brown',
      'Rossi',
      'Khan',
      'Meyer',
    ];
    const pick = <T>(a: T[], i: number) => a[i % a.length]!;
    const started = Date.now();
    const batch = 1000;
    const orgCount = Math.ceil(total / 5);
    for (let i = 0; i < orgCount; i += batch) {
      const rows = Array.from({ length: Math.min(batch, orgCount - i) }, (_, j) => ({
        uuid: newUuid(),
        name: `Load Org ${i + j + 1}`,
        owner_id: pick(owners, i + j),
      }));
      await db('organizations').insert(rows);
    }
    for (let i = 0; i < total; i += batch) {
      const rows = Array.from({ length: Math.min(batch, total - i) }, (_, j) => {
        const n = i + j;
        return {
          uuid: newUuid(),
          first_name: pick(first, n),
          last_name: `${pick(last, n * 7)} ${n + 1}`,
          email: `load.${n + 1}@load.test`,
          owner_id: pick(owners, n),
        };
      });
      await db('contacts').insert(rows);
    }
    const dealCount = Math.ceil(total / 2);
    for (let i = 0; i < dealCount; i += batch) {
      const rows = Array.from({ length: Math.min(batch, dealCount - i) }, (_, j) => {
        const n = i + j;
        return {
          uuid: newUuid(),
          title: `Load deal ${n + 1}`,
          pipeline_id: pipeline.id,
          stage_id: pick(stages, n),
          currency,
          value: (n % 50) * 100 + 500,
          owner_id: pick(owners, n),
          position: n,
        };
      });
      await db('deals').insert(rows);
    }
    out(
      `Inserted ${orgCount} organizations, ${total} contacts and ${dealCount} deals in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
    );
  },

  async 'user:anonymize'(args) {
    const { values } = parseArgs({ args, options: { email: { type: 'string' } } });
    if (!values.email) throw new Error('Pass --email=<email> of a disabled user');
    const u = await db('users').where({ email: values.email.toLowerCase() }).first('uuid');
    if (!u) throw new Error('No user with that email');
    await anonymizeUser(systemContext('cli'), u.uuid as string);
    out('User erased. Their audit entries remain under an anonymous name.');
  },

  async 'crypto:rotate'() {
    const r = await rotateKeys();
    for (const [k, n] of Object.entries(r.done)) out(`${k}: ${n} re-encrypted`);
    for (const [k, n] of Object.entries(r.failed)) out(`FAILED ${k}: ${n} (left as they were; see the log)`);
    for (const key of r.leftovers) out(`Remove the old copy by hand: ${key}`);
    if (Object.keys(r.failed).length) process.exitCode = 2;
    else out('Done. Remove old keys from ENCRYPTION_KEYS only after backups that need them have expired.');
  },

  async 'files:encrypt-existing'() {
    const r = await encryptExistingFiles();
    out(`Encrypted ${r.done.files ?? 0} file(s).`);
    if (r.failed.files) out(`FAILED: ${r.failed.files} file(s) could not be read (see the log).`);
    for (const key of r.leftovers) out(`Remove the unencrypted original by hand: ${key}`);
    if (r.failed.files || r.leftovers.length) process.exitCode = 2;
  },

  async 'audit:seal'() {
    for (const source of ['audit', 'access'] as const)
      out(`${source}: sealed ${await sealPendingDays(source)} day(s)`);
  },

  async 'audit:verify'(args) {
    const { values } = parseArgs({ args, options: { from: { type: 'string' }, to: { type: 'string' } } });
    const day = /^\d{4}-\d{2}-\d{2}$/;
    for (const v of [values.from, values.to])
      if (v !== undefined && !day.test(v)) throw new Error('Dates must look like 2026-01-31');
    const result = await verifyIntegrity({ from: values.from, to: values.to });
    out(`Checked ${result.daysChecked} sealed day(s), sealed through ${result.sealedThrough ?? 'none'}.`);
    for (const p of result.problems) out(`MISMATCH ${p.source} ${p.day}: ${p.problem.replace('_', ' ')}`);
    if (result.problems.length) process.exitCode = 2;
    else out('No problems found.');
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
