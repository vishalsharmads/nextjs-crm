import type { AddressInfo } from 'node:net';
import type { Blueprint } from '@app/blueprints';
import { db } from '../db/knex';
import { createApp } from '../http/app';
import { installModuleGate, loadModules, moduleRouteGroups, refreshModuleStates } from '../modules/registry';
import { fillPlaceholders, type SampleRefs } from './sample-data';

type SampleRequest = NonNullable<Blueprint['sample_data']>['requests'][number];

/**
 * Create a blueprint's sample module records (quotes, invoices, bookings, tickets…) through the app's
 * own API, signed in as `account`, so every module rule applies: numbering, totals, statuses, audit.
 * Placeholders: `{{contact:<ref>}}`, `{{organization:<ref>}}`, `{{deal:<ref>}}`, `{{lead:<ref>}}` (record
 * uuids), `{{req:<ref>}}` (uuid returned by an earlier request), `{{user:<role key>}}` (that demo user's
 * uuid) and `{{date:+7}}`.
 */
export async function runSampleRequests(
  requests: SampleRequest[],
  refs: SampleRefs,
  account: { email: string; password: string },
): Promise<number> {
  if (!requests.length) return 0;
  loadModules();
  installModuleGate();
  await refreshModuleStates();
  const app = createApp({ extraGroups: moduleRouteGroups() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
  };
  let csrf = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: method.toUpperCase(),
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    keep(res);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok)
      throw new Error(
        `Sample request ${method.toUpperCase()} ${path} failed (${res.status}): ${JSON.stringify(json)}`,
      );
    return json;
  };

  try {
    csrf = (await call('get', '/auth/csrf')).token as string;
    await call('post', '/auth/login', account);
    const users = new Map(
      (
        (await db('users as u')
          .join('user_roles as ur', 'ur.user_id', 'u.id')
          .join('roles as r', 'r.id', 'ur.role_id')
          .where('u.email', 'like', 'demo.%')
          .select('u.uuid', 'r.key')) as { uuid: string; key: string }[]
      ).map((u) => [u.key, u.uuid]),
    );
    const results = new Map<string, string>();
    const lookup = (type: string, ref: string) => {
      if (type === 'req') return results.get(ref);
      if (type === 'user') return users.get(ref);
      return refs[type as keyof SampleRefs]?.get(ref)?.uuid;
    };
    for (const r of requests) {
      const path = fillPlaceholders(r.path, lookup) as string;
      const json = await call(r.method, path, fillPlaceholders(r.body, lookup));
      if (r.ref && typeof json.uuid === 'string') results.set(r.ref, json.uuid);
    }
    return requests.length;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
