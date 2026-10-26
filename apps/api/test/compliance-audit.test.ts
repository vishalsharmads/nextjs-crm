import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, restoreSettingsAfterEach, setSettingsGroup } from './helpers';
import { db } from '../src/db/knex';
import { purgeExpiredLogs, sealPendingDays, verifyIntegrity } from '../src/core/audit/integrity';

restoreSettingsAfterEach(['compliance']);

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

describe('access logging', () => {
  it('records nothing until the workspace turns it on', async () => {
    const { client, user } = await clientWithRoles(['admin']);
    const c = await client.post('/contacts', { firstName: 'Quiet' }).expect(201);
    await client.get(`/contacts/${c.body.uuid}`).expect(200);
    expect(await db('access_logs').where({ actor_id: user.id }).first()).toBeUndefined();
  });

  it('records record views, file downloads, exports and audit reads', async () => {
    await setSettingsGroup('compliance', { accessLogging: true });
    const { client, user } = await clientWithRoles(['admin']);
    const c = await client.post('/contacts', { firstName: 'Watched' }).expect(201);
    await client.get(`/contacts/${c.body.uuid}`).expect(200);

    const up = await client.agent
      .post('/api/v1/files')
      .set('x-csrf-token', client.csrf)
      .field('entity', 'contact')
      .field('uuid', c.body.uuid)
      .attach('file', Buffer.from('chart'), 'chart.txt')
      .expect(201);
    const { body: link } = await client.get(`/files/${up.body.uuid}/url`).expect(200);
    await client.agent.get(link.url).expect(200);
    await client.get('/contacts/export').expect(200);
    await client.get('/audit-logs?entity=contact').expect(200);

    const rows = await db('access_logs').where({ actor_id: user.id }).orderBy('id');
    expect(rows.map((r) => r.action)).toEqual(['view', 'download', 'export', 'audit_view']);
    expect(rows[0]).toMatchObject({ entity: 'contact', entity_uuid: c.body.uuid, actor_type: 'user' });
    expect(rows[1].detail).toEqual({ file: up.body.uuid });

    const list = await client.get(`/access-logs?actor=${user.uuid}&action=view`).expect(200);
    expect(list.body.data[0]).toMatchObject({ action: 'view', entityUuid: c.body.uuid });
    await expect(db('access_logs').where({ id: rows[0].id }).update({ action: 'x' })).rejects.toThrow(
      /append-only/,
    );
    await expect(db('access_logs').where({ id: rows[0].id }).delete()).rejects.toThrow(/append-only/);
  });
});

describe('audit viewer', () => {
  it('filters, shows one entry and exports only with the export permission', async () => {
    const { client: admin, user } = await clientWithRoles(['admin']);
    const c = await admin.post('/contacts', { firstName: 'Filtered' }).expect(201);
    const list = await admin.get(`/audit-logs?actor=${user.uuid}&entityUuid=${c.body.uuid}`).expect(200);
    expect(list.body.data).toHaveLength(1);
    const one = await admin.get(`/audit-logs/${list.body.data[0].id}`).expect(200);
    expect(one.body.action).toBe('contact.created');

    const csv = await admin.get(`/audit-logs/export?entityUuid=${c.body.uuid}`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('contact.created');
    expect(
      await db('audit_logs').where({ action: 'audit.exported', actor_id: user.id }).first(),
    ).toBeTruthy();

    const viewer = await createRole(['core.audit.view']);
    const { client } = await clientWithRoles([viewer]);
    await client.get('/audit-logs').expect(200);
    await client.get('/audit-logs/export').expect(403);
    await client.get('/access-logs/export').expect(403);
  });

  it('hides custom fields the viewer cannot see from diffs', async () => {
    const viewer = await createRole(['core.audit.view']);
    const { client: admin } = await clientWithRoles(['admin']);
    const field = await admin
      .post('/custom-fields', {
        entity: 'contact',
        key: 'diagnosis_note',
        label: 'Diagnosis note',
        type: 'text',
        visibility: { default: 'write', roles: { [viewer]: 'hidden' } },
      })
      .expect(201);
    const c = await admin
      .post('/contacts', { firstName: 'Private', custom: { diagnosis_note: 'secret-first-value' } })
      .expect(201);
    await admin
      .patch(`/contacts/${c.body.uuid}`, { custom: { diagnosis_note: 'secret-second-value' } })
      .expect(200);

    const { client } = await clientWithRoles([viewer]);
    const seen = await client.get(`/audit-logs?entityUuid=${c.body.uuid}`).expect(200);
    expect(JSON.stringify(seen.body.data)).not.toContain('secret-first-value');
    expect(JSON.stringify(seen.body.data)).not.toContain('secret-second-value');
    const adminView = await admin.get(`/audit-logs?entityUuid=${c.body.uuid}`).expect(200);
    expect(JSON.stringify(adminView.body.data)).toContain('secret-second-value');
    await admin.post(`/custom-fields/${field.body.uuid}/archive`).expect(200);
  });
});

describe('integrity digests and retention', () => {
  let contactUuid = '';
  let contactId = 0;

  beforeAll(async () => {
    // Rows on past days must exist before those days are sealed.
    const { client } = await clientWithRoles(['admin']);
    const c = await client
      .post('/contacts', { firstName: 'Sealed', email: 'sealed@example.test' })
      .expect(201);
    contactUuid = c.body.uuid;
    contactId = (await db('contacts').where({ uuid: contactUuid }).first('id')).id;
    for (const n of [4, 3]) {
      await db('audit_logs').insert({
        actor_type: 'system',
        action: 'contact.updated',
        entity: 'contact',
        entity_id: contactId,
        entity_uuid: contactUuid,
        diff: JSON.stringify({ email: { from: null, to: 'sealed@example.test' } }),
        created_at: daysAgo(n),
      });
      await db('access_logs').insert({
        actor_type: 'system',
        action: 'view',
        entity: 'contact',
        entity_id: contactId,
        created_at: daysAgo(n),
      });
    }
    await sealPendingDays('audit');
    await sealPendingDays('access');
  });

  it('seals each finished day once and verifies cleanly', async () => {
    expect(await sealPendingDays('audit')).toBe(0);
    const sealed = await db('audit_digests')
      .where({ source: 'audit', day: dayKey(daysAgo(3)) })
      .first();
    expect(sealed.row_count).toBeGreaterThan(0);
    expect(
      await db('audit_digests')
        .where({ day: dayKey(new Date()) })
        .first(),
    ).toBeUndefined();
    const { client } = await clientWithRoles(['admin']);
    const res = await client.post('/audit-logs/verify').expect(200);
    expect(res.body.problems).toEqual([]);
    expect(res.body.daysChecked).toBeGreaterThan(0);
  });

  it('detects a changed row and a changed digest', async () => {
    const row = await db('audit_logs')
      .where({ entity_uuid: contactUuid, action: 'contact.updated' })
      .where('created_at', '<', daysAgo(2))
      .first();
    const original = row.action as string;
    await db.transaction(async (trx) => {
      await trx.raw('SET @audit_redaction = 1');
      await trx('audit_logs').where({ id: row.id }).update({ action: 'contact.viewed' });
      await trx.raw('SET @audit_redaction = 0');
    });
    const tampered = await verifyIntegrity({ sources: ['audit'] });
    expect(tampered.problems).toContainEqual({
      source: 'audit',
      day: dayKey(new Date(row.created_at)),
      problem: 'rows_changed',
    });
    await db.transaction(async (trx) => {
      await trx.raw('SET @audit_redaction = 1');
      await trx('audit_logs').where({ id: row.id }).update({ action: original });
      await trx.raw('SET @audit_redaction = 0');
    });

    const digest = await db('audit_digests').where({ source: 'access' }).orderBy('day').first();
    await db('audit_digests')
      .where({ source: 'access', day: digest.day })
      .update({ chain: 'f'.repeat(64) });
    const broken = await verifyIntegrity({ sources: ['access'] });
    expect(broken.problems.map((p) => p.problem)).toContain('chain_broken');
    await db('audit_digests').where({ source: 'access', day: digest.day }).update({ chain: digest.chain });
    expect((await verifyIntegrity()).problems).toEqual([]);
  });

  it('reseals days that a privacy erasure redacted, and audits it', async () => {
    // Tamper with a sealed row first: the erasure must record it, not silently reseal it.
    const target = await db('audit_logs')
      .where({ entity_uuid: contactUuid, action: 'contact.updated' })
      .where('created_at', '<', daysAgo(2))
      .first();
    await db.transaction(async (trx) => {
      await trx.raw('SET @audit_redaction = 1');
      await trx('audit_logs').where({ id: target.id }).update({ action: 'contact.tampered' });
      await trx.raw('SET @audit_redaction = 0');
    });
    const { client } = await clientWithRoles(['admin']);
    await client.post(`/privacy/contact/${contactUuid}/anonymize`).expect(200);
    const failure = await db('audit_logs')
      .where({ action: 'audit.integrity_failed' })
      .orderBy('id', 'desc')
      .first();
    expect(failure.diff.days).toContain(dayKey(new Date(target.created_at)));
    expect((await verifyIntegrity()).problems).toEqual([]);
    const resealed = await db('audit_logs').where({ action: 'audit.resealed' }).orderBy('id', 'desc').first();
    expect(resealed.diff.changes.length).toBeGreaterThan(0);
  });

  it('deletes only sealed days past retention and keeps their digests', async () => {
    await expect(db('audit_logs').where({ entity_id: contactId }).delete()).rejects.toThrow(/append-only/);
    await setSettingsGroup('compliance', { auditRetentionDays: 2 });
    const result = await purgeExpiredLogs();
    expect(result.audit).toBeGreaterThan(0);
    expect(result.access).toBeGreaterThan(0);
    expect(await db('audit_logs').where('created_at', '<', daysAgo(2.5)).first()).toBeUndefined();
    expect(
      await db('audit_logs').where({ entity_uuid: contactUuid, action: 'contact.created' }).first(),
    ).toBeTruthy();
    const old = await db('audit_digests')
      .where({ source: 'audit', day: dayKey(daysAgo(3)) })
      .first();
    expect(old.purged_at).not.toBeNull();
    expect((await verifyIntegrity()).problems).toEqual([]);
    expect(await db('audit_logs').where({ action: 'audit.purged' }).first()).toBeTruthy();
  });

  it('keeps logs forever when retention is 0', async () => {
    await setSettingsGroup('compliance', { auditRetentionDays: 0 });
    expect(await purgeExpiredLogs()).toEqual({ audit: 0, access: 0 });
  });
});
