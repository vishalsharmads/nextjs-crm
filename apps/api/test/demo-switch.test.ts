import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonymousClient, clientWithRoles, createRole, type Client } from './helpers';
import { env } from '../src/config/env';

/**
 * The switch itself is `resetDemo`, exercised as the real CLI in demo-reset.test.ts. Here: the endpoints
 * exist only in demo mode, only admins reach them, and every guard refuses before anything is touched
 * (the test database is not a demo database, and resets never run under NODE_ENV=test).
 */
describe('demo industry switch', () => {
  let admin: Client;
  let manager: Client;

  beforeAll(async () => {
    env.DEMO_MODE = false;
    ({ client: admin } = await clientWithRoles(['admin']));
    ({ client: manager } = await clientWithRoles([await createRole(['core.settings.manage'])]));
  });

  afterEach(() => {
    env.DEMO_MODE = false;
  });

  it('is hidden unless DEMO_MODE is on', async () => {
    await admin.get('/settings/demo').expect(404);
    await admin.post('/settings/demo/switch', { industry: 'law-firms', confirm: 'law-firms' }).expect(404);
    await (await anonymousClient()).get('/public/demo/switch').expect(404);
  });

  it('lists industries and explains why this database cannot be switched', async () => {
    env.DEMO_MODE = true;
    const res = await admin.get('/settings/demo').expect(200);
    expect(res.body.industries).toContainEqual({ slug: 'law-firms', name: expect.any(String) });
    expect(res.body.allowed).toBe(false);
    expect(res.body.reason).toMatch(/NODE_ENV=test/);
  });

  it('is for admins only', async () => {
    env.DEMO_MODE = true;
    await manager.get('/settings/demo').expect(403);
    await manager.post('/settings/demo/switch', { industry: 'law-firms', confirm: 'law-firms' }).expect(403);
  });

  it('needs the industry typed to confirm', async () => {
    env.DEMO_MODE = true;
    const res = await admin
      .post('/settings/demo/switch', { industry: 'law-firms', confirm: 'law' })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses through the demo:reset guards and leaves the switch idle', async () => {
    env.DEMO_MODE = true;
    const res = await admin
      .post('/settings/demo/switch', { industry: 'law-firms', confirm: 'law-firms' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const status = await (await anonymousClient()).get('/public/demo/switch').expect(200);
    expect(status.body.state).toBe('idle');
  });
});
