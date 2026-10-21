import { afterAll, describe, expect, it } from 'vitest';
import { anonymousClient } from './helpers';
import { db } from '../src/db/knex';
import { env } from '../src/config/env';
import { clearSettingsCache } from '../src/core/settings/settings.service';

describe('demo accounts on the sign-in screen', () => {
  afterAll(async () => {
    env.DEMO_MODE = false;
    await db('settings').where({ key: 'demo_login' }).delete();
    clearSettingsCache();
  });

  it('shows seeded accounts only while DEMO_MODE is on', async () => {
    const accounts = [
      { label: 'Admin', email: 'demo.admin@demo.test', password: 'DemoAccess2026!' },
      { label: 'Front desk', email: 'demo.front-desk@demo.test', password: 'DemoAccess2026!' },
    ];
    await db('settings')
      .insert({ key: 'demo_login', group: 'system', value: JSON.stringify({ accounts }), is_public: false })
      .onConflict('key')
      .merge();
    clearSettingsCache();
    const client = await anonymousClient();

    env.DEMO_MODE = false;
    expect((await client.get('/public/branding').expect(200)).body.demoAccounts).toEqual([]);

    env.DEMO_MODE = true;
    expect((await client.get('/public/branding').expect(200)).body.demoAccounts).toEqual(accounts);
  });

  it('still reads the single-account shape from earlier versions', async () => {
    await db('settings')
      .where({ key: 'demo_login' })
      .update({ value: JSON.stringify({ enabled: true, email: 'old@demo.test', password: 'x' }) });
    clearSettingsCache();
    env.DEMO_MODE = true;
    const client = await anonymousClient();
    expect((await client.get('/public/branding')).body.demoAccounts).toEqual([
      { label: 'Admin', email: 'old@demo.test', password: 'x' },
    ]);
  });
});
