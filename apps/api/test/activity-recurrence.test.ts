import { describe, expect, it } from 'vitest';
import { clientWithRoles } from './helpers';
import { db } from '../src/db/knex';

const DAY = 86_400_000;

describe('recurring tasks', () => {
  it('creates the next occurrence on completion, with a fresh checklist, once', async () => {
    const { client } = await clientWithRoles(['admin']);
    const due = new Date(Date.now() + DAY);
    due.setUTCSeconds(0, 0);
    const task = await client
      .post('/activities', {
        type: 'task',
        subject: 'Weekly check-in',
        dueAt: due.toISOString(),
        reminderAt: new Date(due.getTime() - 3600_000).toISOString(),
        recurrence: { freq: 'weekly', count: 3 },
      })
      .expect(201);
    expect(task.body.recurrence).toMatchObject({ freq: 'weekly', interval: 1, count: 3 });
    const item = await client
      .post(`/activities/${task.body.uuid}/checklist`, { label: 'Review notes' })
      .expect(201);
    await client.patch(`/activities/checklist/${item.body.uuid}`, { done: true }).expect(200);

    await client.post(`/activities/${task.body.uuid}/complete`).expect(200);
    const parent = await db('activities').where({ uuid: task.body.uuid }).first('id');
    const next = await db('activities').where({ recurrence_parent_id: parent.id }).first();
    expect(next).toBeTruthy();
    expect(new Date(next.due_at).getTime() - due.getTime()).toBe(7 * DAY);
    // The reminder keeps its offset, the checklist starts unticked, one fewer occurrence is left.
    expect(new Date(next.due_at).getTime() - new Date(next.reminder_at).getTime()).toBe(3600_000);
    expect(next.recurrence.count).toBe(2);
    const dto = (await client.get(`/activities/${next.uuid}`)).body;
    expect(dto.checklist).toEqual({ done: 0, total: 1 });

    // Reopen and complete again: no second copy.
    await client.post(`/activities/${task.body.uuid}/reopen`).expect(200);
    await client.post(`/activities/${task.body.uuid}/complete`).expect(200);
    expect(await db('activities').where({ recurrence_parent_id: parent.id }).count('* as n').first()).toEqual(
      {
        n: 1,
      },
    );
  });

  it('also repeats when completed through an edit, and stops when the count runs out', async () => {
    const { client } = await clientWithRoles(['admin']);
    const task = await client
      .post('/activities', {
        type: 'task',
        subject: 'Last one',
        dueAt: new Date(Date.now() + DAY).toISOString(),
        recurrence: { freq: 'daily', count: 2 },
      })
      .expect(201);
    await client.patch(`/activities/${task.body.uuid}`, { completed: true }).expect(200);
    const parent = await db('activities').where({ uuid: task.body.uuid }).first('id');
    const second = await db('activities').where({ recurrence_parent_id: parent.id }).first();
    expect(second).toBeTruthy();
    await client.post(`/activities/${second.uuid}/complete`).expect(200);
    expect(await db('activities').where({ recurrence_parent_id: second.id }).first()).toBeUndefined();
  });

  it('refuses invalid rules', async () => {
    const { client } = await clientWithRoles(['admin']);
    const res = await client.post('/activities', {
      type: 'task',
      subject: 'Bad',
      recurrence: { freq: 'daily', byWeekday: [1] },
    });
    expect(res.status).toBe(422);
  });
});
