import { afterAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole } from './helpers';
import { db } from '../src/db/knex';
import { env } from '../src/config/env';
import { decrypt, resetKeyRing } from '../src/lib/crypto';
import { rotateKeys } from '../src/core/security/rotation';
import { clearModuleSettingsCache, getModuleSettings, secretAad } from '../src/modules/module-settings';

afterAll(async () => {
  await db('module_states').where({ module_key: 'notes-demo' }).update({ settings: null });
  clearModuleSettingsCache();
});

describe('module settings', () => {
  it('shows fields with defaults, stores secrets encrypted and never returns them', async () => {
    const { client } = await clientWithRoles(['admin']);
    const detail = await client.get('/modules/notes-demo').expect(200);
    expect(detail.body.settings.fields.map((f: { key: string }) => f.key)).toEqual([
      'widget_count',
      'share_url',
      'share_token',
    ]);
    expect(detail.body.settings.values).toEqual({
      widget_count: 5,
      share_url: null,
      share_token: { set: false },
    });
    expect(detail.body.canTest).toBe(true);

    const saved = await client
      .patch('/modules/notes-demo/settings', {
        widget_count: 3,
        share_url: 'https://hooks.example.com/notes',
        share_token: 'tok-123',
      })
      .expect(200);
    expect(saved.body.values.share_token).toEqual({ set: true });
    expect(JSON.stringify(saved.body)).not.toContain('tok-123');

    const row = await db('module_states').where({ module_key: 'notes-demo' }).first('settings');
    const stored = (typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings) as Record<
      string,
      string
    >;
    expect(stored.share_token).not.toContain('tok-123');
    expect(decrypt(stored.share_token!, secretAad('notes-demo', 'share_token'))).toBe('tok-123');
    clearModuleSettingsCache();
    expect(await getModuleSettings('notes-demo')).toMatchObject({ widget_count: 3, share_token: 'tok-123' });

    // Leaving a secret out keeps it; null clears it.
    await client.patch('/modules/notes-demo/settings', { widget_count: 4 }).expect(200);
    clearModuleSettingsCache();
    expect((await getModuleSettings('notes-demo')).share_token).toBe('tok-123');

    const log = await db('audit_logs')
      .where({ action: 'module.settings_changed' })
      .orderBy('id', 'desc')
      .limit(2);
    expect(JSON.stringify(log.map((l) => l.diff))).not.toContain('tok-123');
    expect(JSON.stringify(log[1].diff)).toContain('[changed]');
  });

  it('validates values against the field types', async () => {
    const { client } = await clientWithRoles(['admin']);
    expect((await client.patch('/modules/notes-demo/settings', { widget_count: 'many' })).status).toBe(422);
    expect((await client.patch('/modules/notes-demo/settings', { share_url: 'ftp://x' })).status).toBe(422);
    expect((await client.patch('/modules/notes-demo/settings', { unknown: 1 })).status).toBe(422);
    expect((await client.patch('/modules/not-a-module/settings', {})).status).toBe(404);
  });

  it('tests the connection with unsaved values and refuses private addresses', async () => {
    const { client } = await clientWithRoles(['admin']);
    const ok = await client
      .post('/modules/notes-demo/test', { share_url: 'https://hooks.example.com/x', share_token: 'abc' })
      .expect(200);
    expect(ok.body.ok).toBe(true);
    const was = env.WEBHOOKS_ALLOW_PRIVATE;
    env.WEBHOOKS_ALLOW_PRIVATE = false;
    try {
      const local = await client
        .post('/modules/notes-demo/test', { share_url: 'https://127.0.0.1:9/x', share_token: 'abc' })
        .expect(200);
      expect(local.body).toMatchObject({ ok: false, message: expect.stringContaining('not reachable') });
    } finally {
      env.WEBHOOKS_ALLOW_PRIVATE = was;
    }
    expect((await client.post('/modules/bookings/test', {})).status).toBe(404);
  });

  it('is for module managers only', async () => {
    const { client } = await clientWithRoles([await createRole(['core.contacts.view'])]);
    expect((await client.get('/modules/notes-demo')).status).toBe(403);
    expect((await client.patch('/modules/notes-demo/settings', { widget_count: 2 })).status).toBe(403);
  });

  it('re-encrypts module secrets when keys rotate', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.patch('/modules/notes-demo/settings', { share_token: 'rotate-me' }).expect(200);
    const previous = env.ENCRYPTION_KEYS;
    env.ENCRYPTION_KEYS = `k1:${'1'.repeat(64)},k0:${env.ENCRYPTION_KEY}`;
    resetKeyRing();
    try {
      const report = await rotateKeys();
      expect(report.done['module_states.settings']).toBe(1);
      expect((await getModuleSettings('notes-demo')).share_token).toBe('rotate-me');
    } finally {
      env.ENCRYPTION_KEYS = `k0:${env.ENCRYPTION_KEY},k1:${'1'.repeat(64)}`;
      resetKeyRing();
      await rotateKeys();
      env.ENCRYPTION_KEYS = previous;
      resetKeyRing();
    }
  });
});
