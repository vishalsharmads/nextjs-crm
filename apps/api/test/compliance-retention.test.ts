import { beforeAll, describe, expect, it } from 'vitest';
import {
  clientWithRoles,
  createUser,
  restoreSettingsAfterEach,
  setSettingsGroup,
  takeMail,
  type Client,
} from './helpers';
import { db } from '../src/db/knex';
import { newUuid } from '../src/lib/ids';
import { notify } from '../src/core/notifications/notifications.service';
import { redactQuery } from '../src/http/app';

restoreSettingsAfterEach(['compliance']);

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

let admin: Client;
beforeAll(async () => {
  ({ client: admin } = await clientWithRoles(['admin']));
});

describe('retention rules', () => {
  it('previews and applies rules, skipping people with open requests or recent activity', async () => {
    const closed = await admin.post('/leads', { firstName: 'Closed', status: 'unqualified' }).expect(201);
    const asked = await admin.post('/leads', { firstName: 'Asked', status: 'unqualified' }).expect(201);
    await db('leads')
      .whereIn('uuid', [closed.body.uuid, asked.body.uuid])
      .update({ updated_at: ago(40) });
    await admin
      .post('/privacy/requests', { type: 'access', subjectEntity: 'lead', subjectUuid: asked.body.uuid })
      .expect(201);

    const binned = await admin.post('/contacts', { firstName: 'Binned' }).expect(201);
    await db('contacts')
      .where({ uuid: binned.body.uuid })
      .update({ deleted_at: ago(20) });

    const dormant = await admin
      .post('/contacts', { firstName: 'Dormant', email: 'dormant@example.test' })
      .expect(201);
    const busy = await admin.post('/contacts', { firstName: 'Busy' }).expect(201);
    await db('contacts')
      .whereIn('uuid', [dormant.body.uuid, busy.body.uuid])
      .update({ updated_at: ago(400) });
    await admin
      .post('/activities', {
        type: 'note',
        body: 'Recent',
        related: { type: 'contact', uuid: busy.body.uuid },
      })
      .expect(201);

    await setSettingsGroup('compliance', {
      retentionRules: [
        { entity: 'lead', condition: 'lead_closed', days: 30, action: 'delete' },
        { entity: 'contact', condition: 'deleted', days: 10, action: 'delete' },
        { entity: 'contact', condition: 'inactive', days: 365, action: 'anonymize' },
      ],
    });
    const preview = await admin.get('/privacy/retention/preview').expect(200);
    expect(preview.body.rules.map((r: { matches: number }) => r.matches >= 1)).toEqual([true, true, true]);

    const run = await admin.post('/privacy/retention/run').expect(200);
    expect(run.body.erased.every((e: { failed: number }) => e.failed === 0)).toBe(true);
    expect(await db('leads').where({ uuid: closed.body.uuid }).first()).toBeUndefined();
    expect(await db('leads').where({ uuid: asked.body.uuid }).first()).toBeTruthy();
    expect(await db('contacts').where({ uuid: binned.body.uuid }).first()).toBeUndefined();
    expect((await db('contacts').where({ uuid: dormant.body.uuid }).first()).email).toBeNull();
    expect((await db('contacts').where({ uuid: busy.body.uuid }).first()).first_name).toBe('Busy');
    expect(await db('audit_logs').where({ action: 'retention.run' }).first()).toBeTruthy();
    // A second run finds nothing left to do for these rules.
    const again = await admin.get('/privacy/retention/preview').expect(200);
    expect(again.body.rules[2].matches).toBe(0);
  });

  it('cleans up operational copies of personal data', async () => {
    const user = await createUser({ roleKeys: ['read_only'] });
    await db('notifications').insert([
      {
        uuid: newUuid(),
        user_id: user.id,
        type: 't',
        title: 'Old read',
        read_at: ago(99),
        created_at: ago(100),
      },
      { uuid: newUuid(), user_id: user.id, type: 't', title: 'Old unread', created_at: ago(100) },
      { uuid: newUuid(), user_id: user.id, type: 't', title: 'New read', read_at: new Date() },
    ]);
    await db('jobs').insert({
      uuid: newUuid(),
      type: 'x',
      payload: '{}',
      status: 'succeeded',
      finished_at: ago(40),
    });
    const res = await admin.post('/privacy/retention/run').expect(200);
    expect(res.body.cleaned.notificationsDays).toBeGreaterThanOrEqual(1);
    expect(res.body.cleaned.jobsDays).toBeGreaterThanOrEqual(1);
    const left = await db('notifications').where({ user_id: user.id }).pluck('title');
    expect(left.sort()).toEqual(['New read', 'Old unread']);
  });

  it('rejects a closed-lead rule for contacts', async () => {
    const res = await admin.patch('/settings/compliance', {
      retentionRules: [{ entity: 'contact', condition: 'lead_closed', days: 30, action: 'delete' }],
    });
    expect(res.status).toBe(422);
  });
});

describe('data minimization', () => {
  it('sends webhooks without record data in minimal mode', async () => {
    await setSettingsGroup('compliance', { webhookMinimal: true });
    const hook = await admin
      .post('/webhooks', { name: 'Minimal', url: 'http://127.0.0.1:9/minimal', events: ['contact.updated'] })
      .expect(201);
    const c = await admin.post('/contacts', { firstName: 'Quiet', email: 'quiet@example.test' }).expect(201);
    await admin.patch(`/contacts/${c.body.uuid}`, { jobTitle: 'Nurse' }).expect(200);
    const [delivery] = await db('webhook_deliveries').whereRaw(
      "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.data.uuid')) = ?",
      [c.body.uuid],
    );
    expect(delivery.payload.data).toEqual({
      entity: 'contact',
      uuid: c.body.uuid,
      changedFields: ['job_title'],
    });
    expect(JSON.stringify(delivery.payload)).not.toContain('quiet@example.test');
    await admin.delete(`/webhooks/${hook.body.uuid}`).expect(204);
  });

  it('keeps names out of notification email in minimal mode', async () => {
    await setSettingsGroup('compliance', { notificationEmailMinimal: true });
    const user = await createUser({ roleKeys: ['read_only'] });
    takeMail();
    await notify(user.id, {
      type: 'x',
      title: 'Ann Patient was assigned to you',
      link: '/contacts/x',
      email: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    const [mail] = takeMail().filter((m) => m.to === user.email);
    expect(mail).toBeTruthy();
    expect(`${mail!.subject} ${mail!.html}`).not.toContain('Ann Patient');
    const inApp = await db('notifications').where({ user_id: user.id }).first();
    expect(inApp.title).toBe('Ann Patient was assigned to you');
  });

  it('masks search terms and tokens in request logs', () => {
    expect(redactQuery('/api/v1/contacts?q=jane%40example.test&page=2&pageSize=50')).toBe(
      '/api/v1/contacts?q=*&page=2&pageSize=50',
    );
    expect(redactQuery('/api/v1/files/download?token=abc.def')).toBe('/api/v1/files/download?token=*');
    expect(redactQuery('/api/v1/health')).toBe('/api/v1/health');
  });
});

describe('review fixes: retention and exports', () => {
  it('keeps an inactive contact who still has an open deal', async () => {
    const c = await admin
      .post('/contacts', { firstName: 'Open deal', email: 'opendeal@example.test' })
      .expect(201);
    await admin.post('/deals', { title: 'Still open', contactUuid: c.body.uuid }).expect(201);
    await db('contacts')
      .where({ uuid: c.body.uuid })
      .update({ updated_at: ago(500) });
    await db('deals')
      .whereIn('contact_id', db('contacts').where({ uuid: c.body.uuid }).select('id'))
      .update({ updated_at: ago(500) });
    await setSettingsGroup('compliance', {
      retentionRules: [{ entity: 'contact', condition: 'inactive', days: 365, action: 'anonymize' }],
    });
    await admin.post('/privacy/retention/run').expect(200);
    expect((await db('contacts').where({ uuid: c.body.uuid }).first()).email).toBe('opendeal@example.test');
  });

  it('guards exported cells against spreadsheet formulas', async () => {
    const { csvSafe } = await import('../src/lib/csv');
    expect(csvSafe('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(csvSafe('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvSafe('Plain')).toBe('Plain');
    await admin.post('/contacts', { firstName: '=1+2', lastName: 'Formula' }).expect(201);
    const csv = await admin.get('/contacts/export').expect(200);
    expect(csv.text).toContain(`'=1+2`);
  });
});
