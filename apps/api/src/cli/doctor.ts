import net from 'node:net';
import { env } from '../config/env';
import { db } from '../db/knex';

type Out = (msg: string) => void;

/** Checks the native environment before install (no containers, so versions and privileges can drift). */
export async function runDoctor(out: Out): Promise<boolean> {
  let ok = true;
  const check = (pass: boolean, label: string, hint = '') => {
    out(`${pass ? '✔' : '✖'} ${label}${!pass && hint ? `\n    → ${hint}` : ''}`);
    if (!pass) ok = false;
  };

  const [major] = process.versions.node.split('.').map(Number);
  check((major ?? 0) >= 22, `Node ${process.versions.node}`, 'Use Node 22 or newer (24 LTS recommended)');

  try {
    const [[row]] = (await db.raw(
      'SELECT VERSION() AS v, @@sql_mode AS mode, @@log_bin AS bin, @@log_bin_trust_function_creators AS trust',
    )) as [{ v: string; mode: string; bin: number; trust: number }[]];
    const [maj, min] = row!.v.split('.').map(Number);
    check(
      (maj ?? 0) > 8 || ((maj ?? 0) === 8 && (min ?? 0) >= 4),
      `MySQL ${row!.v}`,
      'MySQL 8.4 LTS or newer is required',
    );
    check(
      row!.mode.includes('STRICT_TRANS_TABLES'),
      'sql_mode includes STRICT_TRANS_TABLES',
      'Enable strict mode',
    );
    const [grants] = (await db.raw('SHOW GRANTS')) as [Record<string, string>[]];
    const text = grants.map((g) => Object.values(g)[0]).join(' ');
    const canTrigger = /ALL PRIVILEGES|TRIGGER/.test(text);
    check(canTrigger, 'Database user can create triggers (audit log)', 'GRANT TRIGGER ON <db>.* TO <user>');
    if (row!.bin === 1 && row!.trust !== 1 && !/ALL PRIVILEGES ON \*\.\*|SUPER|SET_ANY_DEFINER/.test(text)) {
      check(
        false,
        'Binary logging allows trigger creation',
        'SET GLOBAL log_bin_trust_function_creators = 1',
      );
    } else {
      check(true, 'Binary logging allows trigger creation');
    }
  } catch (err) {
    check(false, 'Connect to MySQL', `${(err as Error).message}. Check DATABASE_URL.`);
  }

  const smtpOk = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: env.SMTP_HOST, port: env.SMTP_PORT, timeout: 3000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
  check(smtpOk, `SMTP reachable at ${env.SMTP_HOST}:${env.SMTP_PORT}`, 'Check SMTP_HOST / SMTP_PORT');

  await complianceChecks(out);

  if (env.NODE_ENV === 'production') {
    check(env.APP_URL.startsWith('https://'), 'APP_URL uses https', 'Serve the app over HTTPS in production');
    check(
      env.TRUST_PROXY > 0,
      'TRUST_PROXY set for the reverse proxy',
      'Set TRUST_PROXY=1 behind nginx, or rate limits and audit IPs see only the proxy',
    );
  }
  return ok;
}

/**
 * Hosting safeguards the app cannot enforce itself. Advisory (they do not fail the doctor) and
 * only shown when a compliance profile is active.
 */
async function complianceChecks(out: Out) {
  const advise = (pass: boolean, label: string, hint: string) =>
    out(`${pass ? '✔' : '!'} ${label}${pass ? '' : `\n    → ${hint}`}`);
  let profile = 'standard';
  try {
    const row = await db('settings').where({ key: 'compliance' }).first('value');
    profile = ((row?.value as { profile?: string } | undefined)?.profile ?? 'standard') as string;
  } catch {
    return; // not installed yet
  }
  if (profile === 'standard') return;
  out(`Compliance profile: ${profile}`);
  try {
    const [[v]] = (await db.raw(
      'SELECT @@default_table_encryption AS tde, @@log_bin AS bin, @@binlog_encryption AS binenc, @@require_secure_transport AS tls',
    )) as [{ tde: number | string; bin: number; binenc: number; tls: number }[]];
    advise(
      v!.tde === 1 || v!.tde === 'ON',
      'MySQL encrypts new tables at rest (default_table_encryption)',
      "Set up a MySQL keyring component, then SET PERSIST default_table_encryption=ON and ALTER TABLE … ENCRYPTION='Y' (or use full-disk encryption)",
    );
    if (v!.bin === 1)
      advise(
        v!.binenc === 1,
        'MySQL encrypts binary logs',
        'SET PERSIST binlog_encryption=ON (needs a keyring)',
      );
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(env.DATABASE_URL);
    advise(
      local || v!.tls === 1 || /ssl/i.test(env.DATABASE_URL),
      'Database connection is local or uses TLS',
      'Add TLS to DATABASE_URL (or require_secure_transport=ON) when MySQL runs on another host',
    );
  } catch (err) {
    advise(false, 'Read MySQL encryption settings', (err as Error).message);
  }
  advise(
    !!process.env.BACKUP_ENCRYPTION_KEY_FILE,
    'Backups are encrypted (BACKUP_ENCRYPTION_KEY_FILE)',
    'Create a key file (openssl rand -hex 32 > /etc/crm/backup.key; chmod 600) and set BACKUP_ENCRYPTION_KEY_FILE for deploy/backup.sh',
  );
  advise(
    env.NODE_ENV !== 'production' || env.APP_URL.startsWith('https://'),
    'Traffic is encrypted (HTTPS)',
    'Serve the app over HTTPS',
  );
}
