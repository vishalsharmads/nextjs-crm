import { describe, expect, it } from 'vitest';
import { clientWithRoles, createRole } from './helpers';
import { db } from '../src/db/knex';

describe('modules', () => {
  it('enables a module (running its migrations), gates its routes, and disables without dropping data', async () => {
    const { client } = await clientWithRoles(['admin']);
    expect((await client.get('/m/notes-demo/notes')).status).toBe(404);
    const enabled = await client.post('/modules/notes-demo/enable').expect(200);
    expect(enabled.body.migrations).toEqual(['0001_notes']);
    await client.post('/m/notes-demo/notes', { title: 'Wifi password is on the fridge' }).expect(201);
    expect((await client.get('/m/notes-demo/notes')).body.data).toHaveLength(1);
    const boot = await client.get('/meta/bootstrap').expect(200);
    expect(boot.body.modules.menu.map((m: { key: string }) => m.key)).toContain('notes');
    const widget = await client.get('/dashboards/widgets/module:notes-demo.latest/data').expect(200);
    expect(widget.body.notes).toHaveLength(1);

    await client.post('/modules/notes-demo/disable').expect(204);
    expect((await client.get('/m/notes-demo/notes')).body.error.code).toBe('MODULE_DISABLED');
    expect(await db('m_notes_demo_notes').count({ c: '*' }).first()).toEqual({ c: 1 });
    // Re-enabling does not re-run migrations.
    const again = await client.post('/modules/notes-demo/enable').expect(200);
    expect(again.body.migrations).toEqual([]);
    await client.post('/modules/notes-demo/disable').expect(204);
  });

  it('refuses modules that are not in this build', async () => {
    const { client } = await clientWithRoles(['admin']);
    expect((await client.post('/modules/not-a-module/enable')).status).toBe(404);
    const list = await client.get('/modules').expect(200);
    expect(list.body.data.every((m: { status: string }) => m.status === 'available')).toBe(true);
  });
});

describe('blueprints over HTTP', () => {
  it('lists, previews and exports', async () => {
    const { client } = await clientWithRoles(['admin']);
    const list = await client.get('/blueprints').expect(200);
    expect(list.body.current.key).toBe('generic');
    expect(list.body.available.map((b: { key: string }) => b.key)).toEqual(
      expect.arrayContaining(['generic', 'coworking']),
    );
    const exported = await client.get('/blueprints/export?key=client-preset&version=2.0.0').expect(200);
    expect(exported.body.key).toBe('client-preset');
    const preview = await client
      .post('/blueprints/upload/preview', {
        blueprint: { ...exported.body, key: 'generic', version: '99.0.0' },
      })
      .expect(200);
    expect(preview.body.status).toBe('dry_run');
  });
});

describe('privacy', () => {
  it('anonymizes personal data and redacts it from the audit log', async () => {
    const { client } = await clientWithRoles(['admin']);
    const c = await client
      .post('/contacts', {
        firstName: 'Erase',
        lastName: 'Me',
        email: 'erase.me@example.test',
        phone: '+441234567890',
      })
      .expect(201);
    await client.patch(`/contacts/${c.body.uuid}`, { jobTitle: 'Secret agent' }).expect(200);
    await client.post(`/privacy/contact/${c.body.uuid}/anonymize`).expect(200);
    const after = await client.get(`/contacts/${c.body.uuid}`).expect(200);
    expect(after.body.email).toBeNull();
    expect(after.body.firstName).toBe('Anonymized');
    const logs = await db('audit_logs').where({ entity: 'contact', entity_uuid: c.body.uuid });
    expect(JSON.stringify(logs.map((l) => l.diff))).not.toContain('erase.me@example.test');
    expect(logs.some((l) => l.action === 'contact.anonymized')).toBe(true);
    // Normal paths still cannot touch the audit log.
    await expect(
      db('audit_logs').where({ entity_uuid: c.body.uuid }).update({ action: 'x' }),
    ).rejects.toThrow(/append-only/);
  });

  it('hard-deletes only with a confirmation code and only for privacy managers', async () => {
    const { client } = await clientWithRoles(['admin']);
    const c = await client.post('/contacts', { firstName: 'Gone', email: 'gone@example.test' }).expect(201);
    const first = await client.delete(`/privacy/contact/${c.body.uuid}`).expect(422);
    const code = first.body.error.details[0].message;
    await client.delete(`/privacy/contact/${c.body.uuid}?confirm=${code}`).expect(204);
    expect(await db('contacts').where({ uuid: c.body.uuid }).first()).toBeUndefined();
    const role = await createRole(['core.contacts.*'], { '*': 'all' });
    const { client: other } = await clientWithRoles([role]);
    expect((await other.post(`/privacy/contact/${c.body.uuid}/anonymize`)).status).toBe(403);
  });
});

describe('openapi', () => {
  it('documents every registered route', async () => {
    const { client } = await clientWithRoles(['admin']);
    const res = await client.get('/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/contacts', '/api/v1/contacts/{uuid}', '/api/v1/deals/board']),
    );
  });
});
