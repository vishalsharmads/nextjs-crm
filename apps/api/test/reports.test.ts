import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, unique, type Client } from './helpers';
import { db } from '../src/db/knex';

/** A currency no other test uses, so totals only count this file's deals. */
const CUR = 'XTS';
const month = (offset: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 15)).toISOString().slice(0, 10);
};

describe('sales reports', () => {
  let admin: Client;
  let pipeline: {
    uuid: string;
    stages: { uuid: string; probability: number; isWon: boolean; isLost: boolean }[];
  };

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    const pipes = await admin.get('/pipelines').expect(200);
    pipeline = (pipes.body.data ?? pipes.body).find((p: { entity: string }) => p.entity === 'deal');
  });

  const deal = (client: Client, body: object) =>
    client
      .post('/deals', { title: unique('D'), currency: CUR, pipelineUuid: pipeline.uuid, ...body })
      .expect(201);

  it('forecasts open value by close month, weighted by stage probability, with won value', async () => {
    const stage = pipeline.stages.find((s) => !s.isWon && !s.isLost && s.probability > 0)!;
    const won = pipeline.stages.find((s) => s.isWon)!;
    await deal(admin, { value: 1000, stageUuid: stage.uuid, expectedClose: month(1) });
    await deal(admin, { value: 500, stageUuid: stage.uuid, expectedClose: month(-2) });
    await deal(admin, { value: 200, stageUuid: stage.uuid });
    await deal(admin, { value: 300, stageUuid: won.uuid, expectedClose: month(0) });
    const res = await admin.get(`/reports/forecast?currency=${CUR}&months=3`).expect(200);
    const next = res.body.months[1];
    expect(next).toMatchObject({ count: 1, value: 1000, weighted: (1000 * stage.probability) / 100 });
    expect(res.body.overdue).toMatchObject({ count: 1, value: 500 });
    expect(res.body.undated).toMatchObject({ count: 1, value: 200 });
    expect(res.body.months[0].won).toBe(300);
  });

  it('reports velocity and time in stage', async () => {
    const res = await admin.get(`/reports/velocity?currency=${CUR}&days=30`).expect(200);
    expect(res.body).toMatchObject({ currency: CUR, won: 1, lost: 0, winRate: 1, avgWonValue: 300 });
    expect(res.body.open).toBe(3);
    expect(res.body.stages.length).toBeGreaterThan(0);
  });

  it('sets quotas and reports attainment, within the viewer’s deal scope', async () => {
    const { currency } = (await db('settings').where({ key: 'general' }).first())?.value ?? {
      currency: 'USD',
    };
    const role = await createRole(['core.deals.*', 'core.reports.view'], { 'core.deals': 'own' });
    const repUser = await createUser({ roleKeys: [role] });
    const rep = await loginAs(repUser);
    const period = month(0).slice(0, 7);
    await admin.put('/reports/quotas', { userUuid: repUser.uuid, period, amount: 1000 }).expect(204);
    const won = pipeline.stages.find((s) => s.isWon)!;
    await rep.post('/deals', { title: unique('W'), value: 250, stageUuid: won.uuid, currency }).expect(201);

    const mine = await rep.get(`/reports/quotas?period=${period}`).expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ quota: 1000, won: 250, attainment: 0.25 });
    await rep.put('/reports/quotas', { userUuid: repUser.uuid, period, amount: 1 }).expect(403);

    const all = await admin.get(`/reports/quotas?period=${period}`).expect(200);
    expect(all.body.data.length).toBeGreaterThan(1);
    expect(await db('audit_logs').where({ action: 'quota.set' }).first()).toBeTruthy();
  });

  it('never counts deals outside the viewer’s scope', async () => {
    const role = await createRole(['core.deals.view', 'core.reports.view'], { 'core.deals': 'own' });
    const rep = await loginAs(await createUser({ roleKeys: [role] }));
    const res = await rep.get(`/reports/forecast?currency=${CUR}`).expect(200);
    expect(res.body.overdue.count).toBe(0);
    expect(res.body.undated.count).toBe(0);
    const none = await loginAs(await createUser({ roleKeys: [await createRole(['core.deals.view'])] }));
    await none.get('/reports/forecast').expect(403);
  });
});
