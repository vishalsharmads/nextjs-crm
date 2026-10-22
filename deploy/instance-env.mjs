// Used by backup.sh and restore.sh. Reads the instance .env (run with --env-file), writes a private
// MySQL options file to argv[2] (so the password never touches the shell), and prints
// "<database name>\t<absolute storage dir>".
import { writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

const [, , optionsFile, instanceDir] = process.argv;
const url = new URL(process.env.DATABASE_URL || 'mysql://root@127.0.0.1:3306/crm_dev');
const esc = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
writeFileSync(
  optionsFile,
  [
    '[client]',
    `host=${esc(url.hostname)}`,
    `port=${url.port || 3306}`,
    `user=${esc(decodeURIComponent(url.username))}`,
    `password=${esc(decodeURIComponent(url.password))}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
chmodSync(optionsFile, 0o600);
const storage = process.env.STORAGE_DIR || './storage';
const storageDir = path.isAbsolute(storage) ? storage : path.join(instanceDir, 'apps/api', storage);
process.stdout.write(`${url.pathname.slice(1)}\t${storageDir}\n`);
