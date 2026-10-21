import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fresh instance per run: drop the e2e database and install the generic blueprint with a known admin. */
export default function setup() {
  const url = new URL(process.env.DATABASE_URL_E2E ?? 'mysql://root@127.0.0.1:3306/crm_e2e');
  const name = url.pathname.slice(1);
  if (!/e2e/.test(name)) throw new Error(`Refusing to reset non-e2e database "${name}"`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const auth = url.password ? `-p${decodeURIComponent(url.password)}` : '';
  execSync(
    `mysql -h ${url.hostname} -P ${url.port || 3306} -u ${decodeURIComponent(url.username)} ${auth} -e "DROP DATABASE IF EXISTS \\\`${name}\\\`"`,
    { stdio: 'inherit' },
  );
  execSync(
    `npm run install:instance -- --blueprint=generic --app-name="E2E Workspace" --admin-email=e2e-admin@example.test --admin-password=E2ePassword123 --admin-name="Erin Admin"`,
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: 'development', LOG_LEVEL: 'warn' },
    },
  );
}
