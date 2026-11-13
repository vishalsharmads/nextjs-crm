import { describe, expect, it } from 'vitest';
import { clientWithRoles, createUser, loginAs } from './helpers';
import { db } from '../src/db/knex';

describe('task checklists', () => {
  it('adds, ticks, reorders and removes items, with progress on the task', async () => {
    const { client } = await clientWithRoles(['admin']);
    const task = await client.post('/activities', { type: 'task', subject: 'Onboard member' }).expect(201);
    expect(task.body.checklist).toEqual({ done: 0, total: 0 });
    const url = `/activities/${task.body.uuid}/checklist`;
    const a = await client.post(url, { label: 'Send welcome pack' }).expect(201);
    const b = await client.post(url, { label: 'Book induction' }).expect(201);
    const ticked = await client.patch(`/activities/checklist/${a.body.uuid}`, { done: true }).expect(200);
    expect(ticked.body.done).toBe(true);
    expect(ticked.body.doneBy).not.toBeNull();
    expect((await client.get(`/activities/${task.body.uuid}`)).body.checklist).toEqual({ done: 1, total: 2 });

    const order = await client.put(`${url}/order`, { uuids: [b.body.uuid, a.body.uuid] }).expect(200);
    expect(order.body.data.map((i: { label: string }) => i.label)).toEqual([
      'Book induction',
      'Send welcome pack',
    ]);
    // A partial order is refused.
    expect((await client.put(`${url}/order`, { uuids: [a.body.uuid] })).status).toBe(422);

    await client.delete(`/activities/checklist/${b.body.uuid}`).expect(204);
    expect((await client.get(url)).body.data).toHaveLength(1);
    const audited = await db('audit_logs')
      .where({ entity_uuid: task.body.uuid, action: 'activity.checklist_changed' })
      .count('* as n')
      .first();
    expect(Number(audited?.n)).toBe(5); // add ×2, tick, reorder, remove
  });

  it('hides checklists on tasks outside the caller’s scope', async () => {
    const { client } = await clientWithRoles(['admin']);
    const task = await client.post('/activities', { type: 'task', subject: 'Private' }).expect(201);
    const item = await client
      .post(`/activities/${task.body.uuid}/checklist`, { label: 'Secret' })
      .expect(201);
    const rep = await loginAs(await createUser({ roleKeys: ['sales_rep'] }));
    expect((await rep.get(`/activities/${task.body.uuid}/checklist`)).status).toBe(404);
    expect((await rep.patch(`/activities/checklist/${item.body.uuid}`, { done: true })).status).toBe(404);
    expect((await rep.delete(`/activities/checklist/${item.body.uuid}`)).status).toBe(404);
  });
});
