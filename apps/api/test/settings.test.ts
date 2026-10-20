import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@app/shared';
import { anonymousClient, clientWithRoles } from './helpers';

describe('settings and branding', () => {
  it('serves public branding without auth and without email settings', async () => {
    const c = await anonymousClient();
    const res = await c.get('/public/branding').expect(200);
    expect(res.body.appName).toBe('Test CRM');
    expect(res.body.installed).toBe(true);
    expect(res.body.emailFromAddress).toBeUndefined();
  });

  it('updates branding live and warns about low contrast', async () => {
    const { client } = await clientWithRoles(['admin']);
    const branding = {
      ...DEFAULT_BRANDING,
      appName: 'Harbor Desk',
      colors: { ...DEFAULT_BRANDING.colors, light: { ...DEFAULT_BRANDING.colors.light, ink: '#DDDDDD' } },
    };
    const res = await client.put('/settings/branding', branding).expect(200);
    expect(res.body.warnings.some((w: { pair: string }) => w.pair === 'ink on surface')).toBe(true);
    const pub = await (await anonymousClient()).get('/public/branding');
    expect(pub.body.appName).toBe('Harbor Desk');
    await client.put('/settings/branding', { ...DEFAULT_BRANDING, appName: 'Test CRM' }).expect(200);
  });

  it('rejects invalid colors', async () => {
    const { client } = await clientWithRoles(['admin']);
    const res = await client.put('/settings/branding', {
      ...DEFAULT_BRANDING,
      colors: { light: { primary: 'red' } },
    });
    expect(res.status).toBe(422);
  });

  it('uploads a logo and serves it publicly with the sniffed type', async () => {
    const { client } = await clientWithRoles(['admin']);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const up = await client.agent
      .post('/api/v1/settings/branding/assets/logoLight')
      .set('x-csrf-token', client.csrf)
      .attach('file', png, 'logo.png')
      .expect(200);
    const asset = await (await anonymousClient()).agent.get(up.body.url).expect(200);
    expect(asset.headers['content-type']).toBe('image/png');
    const bad = await client.agent
      .post('/api/v1/settings/branding/assets/logoLight')
      .set('x-csrf-token', client.csrf)
      .attach('file', Buffer.from('<script>alert(1)</script>'), 'logo.png');
    expect(bad.status).toBe(415);
  });

  it('patches a settings group with validation', async () => {
    const { client } = await clientWithRoles(['admin']);
    const res = await client.patch('/settings/general', { currency: 'EUR' }).expect(200);
    expect(res.body.currency).toBe('EUR');
    expect((await client.patch('/settings/general', { currency: 'EURO' })).status).toBe(422);
    await client.patch('/settings/general', { currency: 'USD' }).expect(200);
  });

  it('overrides vocabulary', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client
      .put('/labels', { labels: { contact: { singular: 'Client', plural: 'Clients' } } })
      .expect(200);
    const res = await client.get('/labels').expect(200);
    expect(res.body.contact).toEqual({ singular: 'Client', plural: 'Clients' });
    await client
      .put('/labels', { labels: { contact: { singular: 'Contact', plural: 'Contacts' } } })
      .expect(200);
  });
});
