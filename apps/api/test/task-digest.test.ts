import { describe, expect, it } from 'vitest';
import { clientWithRoles, createUser, loginAs, takeMail } from './helpers';
import { db } from '../src/db/knex';
import { sendTaskDigests } from '../src/core/notifications/notifications.service';

describe('daily task digest', () => {
  it('is opt-in, lists overdue and today’s tasks, and is sent once a day', async () => {
    const { client } = await clientWithRoles(['admin']);
    const person = await createUser({ roleKeys: ['sales_rep'] });
    const me = await loginAs(person);
    const prefs = await me.patch('/me', { notifications: { taskDigest: true } }).expect(200);
    expect(prefs.body.notifications).toMatchObject({ email: true, taskDigest: true });

    // A fixed morning in UTC (the test workspace's zone).
    const morning = new Date('2031-03-10T09:00:00Z');
    await client
      .post('/activities', {
        type: 'task',
        subject: 'Late invoice chase',
        assigneeUuid: person.uuid,
        dueAt: '2031-03-08T10:00:00Z',
      })
      .expect(201);
    await client
      .post('/activities', {
        type: 'task',
        subject: 'Today call',
        assigneeUuid: person.uuid,
        dueAt: '2031-03-10T15:30:00Z',
      })
      .expect(201);
    await client
      .post('/activities', {
        type: 'task',
        subject: 'Next week',
        assigneeUuid: person.uuid,
        dueAt: '2031-03-17T10:00:00Z',
      })
      .expect(201);
    takeMail();

    // Too early in the morning: nothing.
    await sendTaskDigests(new Date('2031-03-10T06:00:00Z'));
    expect(takeMail().filter((m) => m.to === person.email)).toHaveLength(0);

    await sendTaskDigests(morning);
    const mail = takeMail().filter((m) => m.to === person.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.html).toContain('Late invoice chase');
    expect(mail[0]!.html).toContain('Today call');
    expect(mail[0]!.html).not.toContain('Next week');

    await sendTaskDigests(new Date('2031-03-10T11:00:00Z'));
    expect(takeMail().filter((m) => m.to === person.email)).toHaveLength(0);

    // Turned off: nothing the next day.
    await me.patch('/me', { notifications: { taskDigest: false } }).expect(200);
    await sendTaskDigests(new Date('2031-03-11T09:00:00Z'));
    expect(takeMail().filter((m) => m.to === person.email)).toHaveLength(0);
    await db('activities').where('subject', 'in', ['Late invoice chase', 'Today call', 'Next week']).delete();
  });
});
