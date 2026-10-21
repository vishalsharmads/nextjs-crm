import { describe, expect, it } from 'vitest';
import { clientWithRoles, createUser, loginAs, takeMail } from './helpers';
import { db } from '../src/db/knex';
import { sendDueReminders } from '../src/core/notifications/notifications.service';

const csv = (rows: string[][]) =>
  Buffer.from(
    rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'),
  );

describe('saved views', () => {
  it('saves private and shared views and applies their filters', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.post('/contacts', { firstName: 'Viewy', lastName: 'Match', source: 'Referral' }).expect(201);
    const view = await client
      .post('/saved-views', {
        entity: 'contact',
        name: 'Referrals',
        filters: { and: [{ field: 'source', op: 'in', value: ['Referral'] }] },
        isShared: true,
      })
      .expect(201);
    const res = await client.get(`/contacts?view=${view.body.uuid}`).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((c: { source: string }) => c.source === 'Referral')).toBe(true);
    const { client: rep } = await clientWithRoles(['sales_rep']);
    const seen = await rep.get('/saved-views?entity=contact').expect(200);
    expect(seen.body.data.some((v: { uuid: string }) => v.uuid === view.body.uuid)).toBe(true);
    expect((await rep.post('/saved-views', { entity: 'contact', name: 'Mine', isShared: true })).status).toBe(
      403,
    );
    expect((await rep.delete(`/saved-views/${view.body.uuid}`)).status).toBe(404);
  });
});

describe('bulk actions', () => {
  it('tags, assigns and deletes in bulk within scope', async () => {
    const { client } = await clientWithRoles(['admin']);
    const other = await createUser({ roleKeys: ['sales_rep'] });
    const a = await client.post('/contacts', { firstName: 'Bulk', lastName: 'One' }).expect(201);
    const b = await client.post('/contacts', { firstName: 'Bulk', lastName: 'Two' }).expect(201);
    const uuids = [a.body.uuid, b.body.uuid];
    await client.post('/contacts/bulk', { action: 'add_tags', uuids, tags: ['bulk-tag'] }).expect(200);
    expect(
      (await client.get(`/contacts/${a.body.uuid}`)).body.tags.map((t: { name: string }) => t.name),
    ).toContain('bulk-tag');
    const assigned = await client
      .post('/contacts/bulk', { action: 'assign', uuids, ownerUuid: other.uuid })
      .expect(200);
    expect(assigned.body.affected).toBe(2);
    const n = await db('notifications')
      .where({ user_id: other.id, type: 'contact.assigned' })
      .count({ c: '*' })
      .first();
    expect(Number((n as { c: number }).c)).toBe(2);
    const filter = { field: 'tags', op: 'in', value: ['bulk-tag'] };
    const del = await client.post('/contacts/bulk', { action: 'delete', all: true, filter }).expect(200);
    expect(del.body.affected).toBe(2);
    await client.post('/contacts/bulk', { action: 'restore', uuids }).expect(200);
  });

  it('cannot touch records outside the caller’s scope', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const theirs = await admin.post('/deals', { title: 'Not yours' }).expect(201);
    const role = await db('roles').where({ key: 'sales_rep' }).first();
    await db('role_permissions')
      .insert({ role_id: role.id, pattern: 'core.deals.bulk' })
      .onConflict(['role_id', 'pattern'])
      .ignore();
    const { client: rep } = await clientWithRoles(['sales_rep']);
    const res = await rep
      .post('/deals/bulk', {
        action: 'update_field',
        uuids: [theirs.body.uuid],
        field: 'title',
        value: 'Hijacked',
      })
      .expect(200);
    expect(res.body.affected).toBe(0);
    expect((await admin.get(`/deals/${theirs.body.uuid}`)).body.title).toBe('Not yours');
    await db('role_permissions').where({ role_id: role.id, pattern: 'core.deals.bulk' }).delete();
  });
});

describe('import and export', () => {
  it('imports contacts with mapping, coercion, dedupe and an error report', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client
      .post('/custom-fields', {
        entity: 'contact',
        key: 'plan',
        label: 'Plan',
        type: 'select',
        options: [
          { key: 'basic', label: 'Basic' },
          { key: 'pro', label: 'Pro' },
        ],
      })
      .expect(201);
    await client.post('/contacts', { firstName: 'Already', email: 'already@import.test' }).expect(201);
    const file = csv([
      ['First Name', 'Surname', 'E-mail', 'Company', 'Plan'],
      ['Ana', 'Import', 'ana@import.test', 'Importers Ltd', 'Pro'],
      ['Ben', 'Import', 'ben@import.test', 'Importers Ltd', 'basic'],
      ['Dup', 'Licate', 'ALREADY@import.test', '', ''],
      ['Bad', 'Plan', 'bad@import.test', '', 'Platinum'],
    ]);
    const up = await client.agent
      .post('/api/v1/imports')
      .set('x-csrf-token', client.csrf)
      .field('entity', 'contact')
      .attach('file', file, 'contacts.csv')
      .expect(201);
    expect(up.body.total).toBe(4);
    expect(up.body.suggested).toMatchObject({
      'First Name': 'firstName',
      Surname: 'lastName',
      Company: 'organizationName',
      Plan: 'custom.plan',
    });
    const mapping = { ...up.body.suggested, 'E-mail': 'email' };
    const start = await client
      .post('/imports/start', {
        entity: 'contact',
        fileUuid: up.body.fileUuid,
        mapping,
        options: { duplicates: 'skip' },
      })
      .expect(200);
    const status = await client.get(`/imports/${start.body.jobUuid}`).expect(200);
    expect(status.body.status).toBe('succeeded');
    expect(status.body.result).toMatchObject({ created: 2, skipped: 1, failed: 1 });
    const errors = await client.get(`/imports/${start.body.jobUuid}/errors.csv`).expect(200);
    expect(errors.text).toContain('Platinum');
    const ana = await client.get('/contacts?q=ana%40import.test').expect(200);
    expect(ana.body.data[0].custom.plan).toBe('pro');
    expect(ana.body.data[0].organizations[0].organization.name).toBe('Importers Ltd');
  });

  it('exports the current list as CSV with visible custom fields only', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client
      .post('/contacts', { firstName: 'Export', lastName: 'Me', email: 'export.me@example.test' })
      .expect(201);
    const res = await client
      .get(`/contacts/export?q=${encodeURIComponent('export.me@example.test')}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\n');
    expect(lines[0]).toContain('First name');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('export.me@example.test');
    expect(await db('audit_logs').where({ action: 'contact.exported' }).first()).toBeTruthy();
  });

  it('requires the export permission', async () => {
    const { client } = await clientWithRoles(['read_only']);
    expect((await client.get('/contacts/export')).status).toBe(403);
  });
});

describe('dashboard, audit and notifications', () => {
  it('computes widgets within scope', async () => {
    const { client } = await clientWithRoles(['admin']);
    const dashboards = await client.get('/dashboards').expect(200);
    expect(dashboards.body.data.length).toBeGreaterThan(0);
    const pv = await client
      .get(
        `/dashboards/widgets/pipeline_value/data?params=${encodeURIComponent(JSON.stringify({ pipeline: 'sales' }))}`,
      )
      .expect(200);
    expect(pv.body.stages.length).toBeGreaterThan(0);
    const conv = await client.get('/dashboards/widgets/conversion/data').expect(200);
    expect(conv.body).toHaveProperty('winRate');
    const mod = await client.get('/dashboards/widgets/module:bookings.occupancy/data').expect(200);
    expect(mod.body.unavailable).toBe(true);
    const { client: rep } = await clientWithRoles(['sales_rep']);
    const repPv = await rep.get('/dashboards/widgets/pipeline_value/data').expect(200);
    expect(repPv.body.total).toBe(0);
  });

  it('lists the audit log for auditors only', async () => {
    const { client } = await clientWithRoles(['admin']);
    const res = await client.get('/audit-logs?action=contact.').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const { client: rep } = await clientWithRoles(['sales_rep']);
    expect((await rep.get('/audit-logs')).status).toBe(403);
  });

  it('notifies on assignment, sends reminders, and marks read', async () => {
    const { client } = await clientWithRoles(['admin']);
    const assignee = await createUser({ roleKeys: ['sales_rep'] });
    takeMail();
    const past = new Date(Date.now() - 60_000).toISOString();
    await client
      .post('/activities', {
        type: 'task',
        subject: 'Call back',
        assigneeUuid: assignee.uuid,
        reminderAt: past,
      })
      .expect(201);
    await sendDueReminders();
    const c = await loginAs(assignee);
    const count = await c.get('/notifications/unread-count').expect(200);
    expect(count.body.count).toBe(2);
    const list = await c.get('/notifications').expect(200);
    expect(list.body.data.map((n: { type: string }) => n.type).sort()).toEqual([
      'activity.assigned',
      'activity.reminder',
    ]);
    await c.post('/notifications/read-all').expect(204);
    expect((await c.get('/notifications/unread-count')).body.count).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(takeMail().some((m) => m.to === assignee.email)).toBe(true);
    // Reminders are sent once.
    await sendDueReminders();
    expect((await c.get('/notifications/unread-count')).body.count).toBe(0);
  });
});
