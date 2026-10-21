import request from 'supertest';
import type { Express } from 'express';
import { bootstrap } from '../src/boot';
import { db } from '../src/db/knex';
import { hashPassword } from '../src/core/auth/auth.service';
import { newUuid } from '../src/lib/ids';
import { clearAccessCache } from '../src/core/rbac/access';
import { mailbox } from '../src/lib/mailer';

let appPromise: Promise<Express> | null = null;
export function getApp(): Promise<Express> {
  appPromise ??= bootstrap().then((b) => b.app);
  return appPromise;
}

let seq = 0;
export const unique = (prefix = 'u') => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface TestUser {
  id: number;
  uuid: string;
  email: string;
  password: string;
}

export async function createUser(
  opts: {
    roleKeys?: string[];
    email?: string;
    password?: string;
    teamIds?: number[];
    firstName?: string;
  } = {},
): Promise<TestUser> {
  const email = (opts.email ?? `${unique('user')}@example.test`).toLowerCase();
  const password = opts.password ?? 'Password123!';
  const uuid = newUuid();
  const [id] = await db('users').insert({
    uuid,
    email,
    first_name: opts.firstName ?? 'Test',
    last_name: 'User',
    status: 'active',
    password_hash: await hashPassword(password),
  });
  const roles = await db('roles')
    .whereIn('key', opts.roleKeys ?? ['admin'])
    .select('id');
  if (roles.length) await db('user_roles').insert(roles.map((r) => ({ user_id: id, role_id: r.id })));
  for (const teamId of opts.teamIds ?? []) await db('team_members').insert({ team_id: teamId, user_id: id });
  clearAccessCache();
  return { id: id!, uuid, email, password };
}

/** A role with exactly these permissions and scopes (for permission tests). */
export async function createRole(
  permissions: string[],
  scopes: Record<string, string> = {},
): Promise<string> {
  const key = unique('role_').replace(/[^a-z0-9_]/g, '_');
  const [id] = await db('roles').insert({ uuid: newUuid(), key, name: key });
  if (permissions.length)
    await db('role_permissions').insert(permissions.map((pattern) => ({ role_id: id, pattern })));
  const entries = Object.entries(scopes);
  if (entries.length)
    await db('role_scopes').insert(entries.map(([resource, scope]) => ({ role_id: id, resource, scope })));
  clearAccessCache();
  return key;
}

export interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  get(path: string): request.Test;
  post(path: string, body?: object): request.Test;
  patch(path: string, body?: object): request.Test;
  put(path: string, body?: object): request.Test;
  delete(path: string): request.Test;
}

export async function anonymousClient(): Promise<Client> {
  const app = await getApp();
  const agent = request.agent(app);
  const res = await agent.get('/api/v1/auth/csrf');
  const csrf = res.body.token as string;
  const url = (p: string) => (p.startsWith('/api') ? p : `/api/v1${p}`);
  return {
    agent,
    csrf,
    get: (p) => agent.get(url(p)),
    post: (p, b) =>
      agent
        .post(url(p))
        .set('x-csrf-token', csrf)
        .send(b ?? {}),
    patch: (p, b) =>
      agent
        .patch(url(p))
        .set('x-csrf-token', csrf)
        .send(b ?? {}),
    put: (p, b) =>
      agent
        .put(url(p))
        .set('x-csrf-token', csrf)
        .send(b ?? {}),
    delete: (p) => agent.delete(url(p)).set('x-csrf-token', csrf),
  };
}

export async function loginAs(user: TestUser): Promise<Client> {
  const client = await anonymousClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

/** Shortcut: new user with the given roles, logged in. */
export async function clientWithRoles(roleKeys: string[]) {
  const user = await createUser({ roleKeys });
  return { user, client: await loginAs(user) };
}

export function takeMail() {
  const mails = [...(mailbox.capture ?? [])];
  if (mailbox.capture) mailbox.capture.length = 0;
  return mails;
}
