#!/usr/bin/env node
/**
 * Read-heavy load test against a running instance (staging, never production).
 * Signs in, then hammers the screens people use most and reports latency percentiles per endpoint.
 *
 *   node scripts/load-test.mjs --url=http://localhost:4000 --email=a@b.test --password='...' \
 *     [--concurrency=20] [--seconds=30]
 *
 * Seed volume first: npm run cli -w @app/api -- seed:volume --contacts=20000
 * The API's rate limiter applies per IP; raise it on staging or run from several machines for big tests.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:4000' },
    email: { type: 'string' },
    password: { type: 'string' },
    concurrency: { type: 'string', default: '20' },
    seconds: { type: 'string', default: '30' },
  },
});
if (!values.email || !values.password) {
  console.error('Pass --email and --password of a user on the instance under test.');
  process.exit(1);
}
const base = `${values.url.replace(/\/$/, '')}/api/v1`;
const concurrency = Number(values.concurrency);
const seconds = Number(values.seconds);

// ---- Sign in once and share the session (cookies) across workers ----
let cookie = '';
const remember = (res) => {
  const set = res.headers.getSetCookie?.() ?? [];
  const jar = new Map(
    cookie
      .split('; ')
      .filter(Boolean)
      .map((c) => c.split('=')),
  );
  for (const c of set) {
    const [pair] = c.split(';');
    const [k, ...v] = pair.split('=');
    jar.set(k, v.join('='));
  }
  cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
};
const csrfRes = await fetch(`${base}/auth/csrf`);
remember(csrfRes);
const { token } = await csrfRes.json();
const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie },
  body: JSON.stringify({ email: values.email, password: values.password }),
});
if (!login.ok) {
  console.error(`Sign-in failed: ${login.status} ${await login.text()}`);
  process.exit(1);
}
remember(login);

const scenarios = [
  ['contacts list', '/contacts?pageSize=50'],
  ['contacts search', '/contacts?pageSize=25&q=ada'],
  ['contacts sorted page 20', '/contacts?pageSize=50&page=20&sort=-created_at'],
  ['organizations list', '/organizations?pageSize=50'],
  ['deals list', '/deals?pageSize=50'],
  ['deals board', '/deals/board'],
  ['global search', '/search?q=load'],
  ['bootstrap', '/meta/bootstrap'],
  ['dashboards', '/dashboards'],
];

const timings = new Map(scenarios.map(([name]) => [name, []]));
const errors = new Map();
let done = 0;
const deadline = Date.now() + seconds * 1000;

async function worker(id) {
  let i = id;
  while (Date.now() < deadline) {
    const [name, path] = scenarios[i++ % scenarios.length];
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}${path}`, { headers: { cookie, accept: 'application/json' } });
      await res.arrayBuffer();
      if (!res.ok) errors.set(`${name}: ${res.status}`, (errors.get(`${name}: ${res.status}`) ?? 0) + 1);
    } catch (err) {
      errors.set(
        `${name}: ${err.code ?? err.message}`,
        (errors.get(`${name}: ${err.code ?? err.message}`) ?? 0) + 1,
      );
    }
    timings.get(name).push(performance.now() - t0);
    done++;
  }
}

console.log(`Running ${concurrency} workers for ${seconds}s against ${base} …`);
const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
const elapsed = (performance.now() - started) / 1000;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const rows = [...timings].map(([name, t]) => {
  const s = [...t].sort((a, b) => a - b);
  return {
    endpoint: name,
    requests: s.length,
    'p50 ms': Math.round(pct(s, 50)),
    'p95 ms': Math.round(pct(s, 95)),
    'p99 ms': Math.round(pct(s, 99)),
  };
});
console.table(rows);
console.log(`${done} requests in ${elapsed.toFixed(1)}s = ${(done / elapsed).toFixed(0)} req/s`);
if (errors.size) {
  console.log('Errors:');
  for (const [k, n] of errors) console.log(`  ${k} × ${n}`);
  process.exitCode = 1;
} else console.log('No errors.');
