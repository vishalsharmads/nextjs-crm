import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, unique, type Client } from './helpers';

/** Deals in a currency no other test uses, so grouping only sees this file's deals. */
const CUR = 'XBT';

describe('report builder', () => {
  let admin: Client;
  const filter = { field: 'currency', op: 'eq', value: CUR };

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    for (const value of [100, 200, 300])
      await admin.post('/deals', { title: unique('R'), value, currency: CUR }).expect(201);
  });

  it('groups by a field and measures count, sum and average within scope', async () => {
    const count = await admin
      .post('/reports/custom/preview', { entity: 'deal', groupBy: 'status', metric: 'count', filter })
      .expect(200);
    expect(count.body.rows).toEqual([{ key: 'open', label: 'open', value: 3 }]);
    const sum = await admin
      .post('/reports/custom/preview', {
        entity: 'deal',
        groupBy: 'owner',
        metric: 'sum',
        metricField: 'value',
        filter,
      })
      .expect(200);
    expect(sum.body.total).toBe(600);
    expect(sum.body.rows[0].label).toMatch(/\S/);
    const avg = await admin
      .post('/reports/custom/preview', {
        entity: 'deal',
        groupBy: 'stage',
        metric: 'avg',
        metricField: 'value',
        filter,
      })
      .expect(200);
    expect(avg.body.rows[0].value).toBe(200);
    const byMonth = await admin
      .post('/reports/custom/preview', { entity: 'deal', groupBy: 'created_at', dateBucket: 'month', filter })
      .expect(200);
    expect(byMonth.body.rows[0].key).toBe(new Date().toISOString().slice(0, 7));

    // Own scope: a rep with no deals in this currency sees nothing.
    const rep = await loginAs(
      await createUser({
        roleKeys: [await createRole(['core.deals.view', 'core.reports.view'], { 'core.deals': 'own' })],
      }),
    );
    const theirs = await rep
      .post('/reports/custom/preview', { entity: 'deal', groupBy: 'status', filter })
      .expect(200);
    expect(theirs.body.rows).toEqual([]);
  });

  it('refuses fields that could leak or cannot be grouped', async () => {
    await admin.post('/reports/custom/preview', { entity: 'deal', groupBy: 'contact' }).expect(422);
    await admin.post('/reports/custom/preview', { entity: 'deal', groupBy: 'title' }).expect(422);
    await admin.post('/reports/custom/preview', { entity: 'deal', groupBy: 'nope' }).expect(422);
    await admin
      .post('/reports/custom/preview', {
        entity: 'deal',
        groupBy: 'status',
        metric: 'sum',
        metricField: 'title',
      })
      .expect(422);
    const none = await loginAs(await createUser({ roleKeys: [await createRole(['core.reports.view'])] }));
    await none.post('/reports/custom/preview', { entity: 'deal', groupBy: 'status' }).expect(403);
  });

  it('saves, shares and runs reports, and shows them on dashboards', async () => {
    const definition = { entity: 'deal', groupBy: 'status', metric: 'count', filter };
    const mine = await admin.post('/reports/custom', { name: 'Private', definition }).expect(201);
    const shared = await admin
      .post('/reports/custom', { name: 'Team', definition, shared: true })
      .expect(201);
    const run = await admin.get(`/reports/custom/${mine.body.uuid}/run`).expect(200);
    expect(run.body.total).toBe(3);

    const rep = await loginAs(
      await createUser({
        roleKeys: [await createRole(['core.deals.view', 'core.reports.view', 'core.dashboard.view'])],
      }),
    );
    const list = await rep.get('/reports/custom').expect(200);
    const uuids = list.body.data.map((r: { uuid: string }) => r.uuid);
    expect(uuids).toContain(shared.body.uuid);
    expect(uuids).not.toContain(mine.body.uuid);
    await rep.get(`/reports/custom/${mine.body.uuid}/run`).expect(404);
    await rep.delete(`/reports/custom/${shared.body.uuid}`).expect(404);
    await rep.post('/reports/custom', { name: 'x', definition, shared: true }).expect(403);

    const widget = await rep
      .get(
        `/dashboards/widgets/report/data?params=${encodeURIComponent(JSON.stringify({ report: shared.body.uuid }))}`,
      )
      .expect(200);
    expect(widget.body).toMatchObject({ name: 'Team', result: { entity: 'deal' } });
    const hidden = await rep
      .get(
        `/dashboards/widgets/report/data?params=${encodeURIComponent(JSON.stringify({ report: mine.body.uuid }))}`,
      )
      .expect(200);
    expect(hidden.body).toMatchObject({ unavailable: true });
  });

  it('saves a personal dashboard and resets it to the shared one', async () => {
    const { client } = await clientWithRoles(['admin']);
    const widgets = [{ key: 'w1', type: 'tasks_due', title: 'Tasks', size: 'sm', params: {} }];
    const mine = await client.post('/dashboards', { name: 'Mine', widgets }).expect(201);
    expect(
      (await client.get('/dashboards').expect(200)).body.data.some(
        (d: { uuid: string }) => d.uuid === mine.body.uuid,
      ),
    ).toBe(true);
    await admin.delete(`/dashboards/${mine.body.uuid}`).expect(404);
    await client.delete(`/dashboards/${mine.body.uuid}`).expect(204);
    expect(
      (await client.get('/dashboards').expect(200)).body.data.every((d: { mine: boolean }) => !d.mine),
    ).toBe(true);
  });
});
