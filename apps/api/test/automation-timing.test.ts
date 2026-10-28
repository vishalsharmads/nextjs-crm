import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, unique, type Client } from './helpers';
import { db } from '../src/db/knex';
import { nextRun, runDueAutomations } from '../src/core/automations/automations';

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe('delayed and scheduled automations', () => {
  let admin: Client;
  const rules: string[] = [];

  const rule = async (body: object) => {
    const res = await admin.post('/automations', { name: unique('Rule '), ...body }).expect(201);
    rules.push(res.body.uuid);
    return res.body as { uuid: string; nextRunAt: string | null };
  };
  const notes = async (type: string, uuid: string) =>
    (await admin.get(`/activities/for?type=${type}&uuid=${uuid}`).expect(200)).body.data as {
      type: string;
      body: string | null;
    }[];

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
  });

  afterAll(async () => {
    // Rules are shared with other test files: switch them off.
    for (const uuid of rules) await admin.patch(`/automations/${uuid}`, { active: false });
  });

  it('runs a delayed rule later, re-checking the record as it is then', async () => {
    const tag = unique('Delay');
    await rule({
      triggerEvent: 'deal.created',
      delayMinutes: 60,
      conditions: {
        and: [
          { field: 'title', op: 'starts_with', value: tag },
          { field: 'status', op: 'eq', value: 'open' },
        ],
      },
      actions: [{ type: 'add_note', body: 'Followed up on {{record.title}}' }],
    });
    const kept = await admin.post('/deals', { title: `${tag} kept` }).expect(201);
    const won = await admin.post('/deals', { title: `${tag} won` }).expect(201);
    const removed = await admin.post('/deals', { title: `${tag} removed` }).expect(201);
    expect(await notes('deal', kept.body.uuid)).toHaveLength(0);
    expect(await db('automation_queue').where({ record_uuid: kept.body.uuid })).toHaveLength(1);

    const pipes = await admin.get('/pipelines').expect(200);
    const pipeline = (pipes.body.data ?? pipes.body).find(
      (p: { uuid: string }) => p.uuid === won.body.pipeline.uuid,
    );
    const wonStage = pipeline.stages.find((s: { isWon: boolean }) => s.isWon);
    const moved = await admin.patch(`/deals/${won.body.uuid}`, { stageUuid: wonStage.uuid }).expect(200);
    expect(moved.body.status).toBe('won');
    await admin.delete(`/deals/${removed.body.uuid}`).expect(204);
    await runDueAutomations(later(30));
    expect(await notes('deal', kept.body.uuid)).toHaveLength(0);
    await runDueAutomations(later(61));

    expect((await notes('deal', kept.body.uuid)).map((n) => n.body)).toEqual([
      expect.stringContaining(`Followed up on ${tag} kept`),
    ]);
    expect(await notes('deal', won.body.uuid)).toHaveLength(0);
    expect(await db('automation_queue').where({ record_uuid: kept.body.uuid })).toHaveLength(0);
  });

  it('runs a scheduled rule over matching records and moves to the next run', async () => {
    const tag = unique('Sched');
    const r = await rule({
      triggerEvent: 'schedule',
      schedule: { entity: 'deal', frequency: 'daily', time: '09:00' },
      conditions: { field: 'title', op: 'starts_with', value: tag },
      actions: [{ type: 'add_note', body: 'Daily check' }],
    });
    expect(new Date(r.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    const a = await admin.post('/deals', { title: `${tag} a` }).expect(201);
    const other = await admin.post('/deals', { title: unique('Other') }).expect(201);
    await db('automations')
      .where({ uuid: r.uuid })
      .update({ next_run_at: new Date(Date.now() - 1000) });
    await runDueAutomations();
    expect(await notes('deal', a.body.uuid)).toHaveLength(1);
    expect(await notes('deal', other.body.uuid)).toHaveLength(0);
    const after = await db('automations').where({ uuid: r.uuid }).first('next_run_at');
    expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now());
    // Not due again until then.
    await runDueAutomations();
    expect(await notes('deal', a.body.uuid)).toHaveLength(1);
  });

  it('assigns in turn and removes tags', async () => {
    const tag = unique('Rr');
    const [u1, u2] = [await createUser(), await createUser()];
    await rule({
      triggerEvent: 'contact.created',
      conditions: { field: 'last_name', op: 'eq', value: tag },
      actions: [{ type: 'assign', users: [u1.uuid, u2.uuid] }],
    });
    const owners = [];
    for (let i = 0; i < 2; i++) {
      const c = await admin.post('/contacts', { firstName: `P${i}`, lastName: tag }).expect(201);
      owners.push((await admin.get(`/contacts/${c.body.uuid}`).expect(200)).body.owner.uuid);
    }
    expect(new Set(owners)).toEqual(new Set([u1.uuid, u2.uuid]));

    const tagged = unique('Tg');
    await rule({
      triggerEvent: 'contact.updated',
      conditions: { field: 'last_name', op: 'eq', value: tagged },
      actions: [{ type: 'remove_tags', tags: ['temp'] }],
    });
    const c = await admin
      .post('/contacts', { firstName: 'T', lastName: tagged, tags: ['temp', 'keep'] })
      .expect(201);
    await admin.patch(`/contacts/${c.body.uuid}`, { jobTitle: 'x' }).expect(200);
    const names = (await admin.get(`/contacts/${c.body.uuid}`)).body.tags.map(
      (t: { name: string }) => t.name,
    );
    expect(names).toContain('keep');
    expect(names).not.toContain('temp');
  });

  it('makes whoever changes a rule its owner, so nobody borrows wider access', async () => {
    const r = await rule({
      triggerEvent: 'deal.created',
      conditions: { field: 'title', op: 'eq', value: unique('Never') },
      actions: [{ type: 'add_note', body: 'x' }],
    });
    const role = await createRole(['core.automations.manage', 'core.deals.view'], { 'core.deals': 'own' });
    const mgrUser = await createUser({ roleKeys: [role] });
    const mgr = await loginAs(mgrUser);
    await mgr.patch(`/automations/${r.uuid}`, { actions: [{ type: 'add_note', body: 'y' }] }).expect(200);
    const row = await db('automations').where({ uuid: r.uuid }).first('created_by');
    expect(row.created_by).toBe(mgrUser.id);
    await mgr.patch(`/automations/${r.uuid}`, { active: false }).expect(200);
  });

  it('validates schedules', async () => {
    await admin
      .post('/automations', {
        name: 'x',
        triggerEvent: 'schedule',
        actions: [{ type: 'add_note', body: 'x' }],
      })
      .expect(422);
    await admin
      .post('/automations', {
        name: 'x',
        triggerEvent: 'deal.created',
        schedule: { entity: 'deal', frequency: 'daily', time: '09:00' },
        actions: [{ type: 'add_note', body: 'x' }],
      })
      .expect(422);
  });

  it('computes the next run in the workspace time zone', () => {
    const after = new Date('2026-03-07T20:00:00Z');
    // 09:00 in New York on 8 March 2026 is after the daylight saving change (UTC-4).
    expect(
      nextRun(
        { entity: 'deal', frequency: 'daily', weekday: 1, time: '09:00' },
        'America/New_York',
        after,
      ).toISOString(),
    ).toBe('2026-03-08T13:00:00.000Z');
    // Weekly on Monday.
    expect(
      nextRun({ entity: 'deal', frequency: 'weekly', weekday: 1, time: '08:30' }, 'UTC', after).toISOString(),
    ).toBe('2026-03-09T08:30:00.000Z');
  });

  it('drops waiting runs for a person who is erased', async () => {
    const tag = unique('Er');
    await rule({
      triggerEvent: 'contact.created',
      delayMinutes: 30,
      conditions: { field: 'last_name', op: 'eq', value: tag },
      actions: [{ type: 'add_note', body: 'later' }],
    });
    const c = await admin.post('/contacts', { firstName: 'E', lastName: tag }).expect(201);
    expect(await db('automation_queue').where({ record_uuid: c.body.uuid })).toHaveLength(1);
    await admin.post(`/privacy/contact/${c.body.uuid}/anonymize`).expect(200);
    expect(await db('automation_queue').where({ record_uuid: c.body.uuid })).toHaveLength(0);
  });
});
