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
