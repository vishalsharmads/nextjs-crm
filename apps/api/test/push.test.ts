import { afterEach, describe, expect, it } from 'vitest';
import { clientWithRoles, createUser, loginAs, takeMail } from './helpers';
import { db } from '../src/db/knex';
import { env } from '../src/config/env';
import { pushTransport } from '../src/core/push/push';
import { notify } from '../src/core/notifications/notifications.service';

const realSend = pushTransport.send;
afterEach(() => {
  pushTransport.send = realSend;
});

describe('notification preferences and push', () => {
  it('sends push to subscribed browsers per kind, and drops browsers that are gone', async () => {
    const user = await createUser({ roleKeys: ['sales_rep'] });
    const client = await loginAs(user);
    const key = await client.get('/me/push/key').expect(200);
    expect(key.body.publicKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // Endpoints inside the network are refused (tests otherwise allow private addresses).
    const was = env.WEBHOOKS_ALLOW_PRIVATE;
    env.WEBHOOKS_ALLOW_PRIVATE = false;
    try {
      await client
        .post('/me/push/subscriptions', {
          endpoint: 'https://127.0.0.1/x',
          keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(8) },
        })
        .expect(422);
    } finally {
      env.WEBHOOKS_ALLOW_PRIVATE = was;
    }
    await client
      .post('/me/push/subscriptions', {
        endpoint: 'http://push.example.test/x',
        keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(8) },
      })
      .expect(422);

    const subId = await db('push_subscriptions')
      .insert({
        user_id: user.id,
        endpoint: 'https://push.example.test/abc',
        endpoint_hash: 'h'.repeat(64),
        p256dh: 'p'.repeat(20),
        auth: 'a'.repeat(8),
      })
      .then(([id]) => id);
    const sent: string[] = [];
    pushTransport.send = (_sub, payload) => {
      sent.push(JSON.parse(payload).title as string);
      return Promise.resolve();
    };
    await notify(user.id, { type: 'deal.assigned', title: 'Assigned: Harbour', link: '/deals/x' });
    // "Automations and everything else" is off for push by default.
    await notify(user.id, { type: 'automation.notice', title: 'Rule ran' });
    expect(sent).toEqual(['Assigned: Harbour']);

    // Turn push off for assignments, on for everything else.
    const me = await client
      .patch('/me', { notifications: { categories: { assigned: { push: false }, other: { push: true } } } })
      .expect(200);
    expect(me.body.notifications.categories.assigned).toEqual({ email: true, push: false });
    expect(me.body.notifications.categories.other.push).toBe(true);
    sent.length = 0;
    await notify(user.id, { type: 'deal.assigned', title: 'Again' });
    await notify(user.id, { type: 'automation.notice', title: 'Rule ran' });
    expect(sent).toEqual(['Rule ran']);

    // A browser the push service no longer knows is removed.
    pushTransport.send = () => Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 }));
    await notify(user.id, { type: 'automation.notice', title: 'x' });
    expect(await db('push_subscriptions').where({ id: subId }).first()).toBeUndefined();
  });

  it('lets people choose email per kind of notification', async () => {
    const user = await createUser({ roleKeys: ['sales_rep'] });
    const client = await loginAs(user);
    takeMail();
    await client.patch('/me', { notifications: { categories: { comments: { email: true } } } }).expect(200);
    await notify(user.id, { type: 'comment.created', title: 'New comment' });
    await new Promise((r) => setTimeout(r, 50));
    expect(takeMail().filter((m) => m.to === user.email)).toHaveLength(1);
    await client.patch('/me', { notifications: { categories: { comments: { email: false } } } }).expect(200);
    await notify(user.id, { type: 'comment.created', title: 'Another', email: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(takeMail().filter((m) => m.to === user.email)).toHaveLength(0);
  });

  it('forgets browsers when the password changes (other sessions end)', async () => {
    const { client, user } = await clientWithRoles(['sales_rep']);
    await db('push_subscriptions').insert({
      user_id: user.id,
      endpoint: 'https://push.example.test/zzz',
      endpoint_hash: 'z'.repeat(64),
      p256dh: 'p'.repeat(20),
      auth: 'a'.repeat(8),
    });
    await client
      .post('/me/password', { currentPassword: user.password, newPassword: 'AnotherPass123!' })
      .expect(204);
    expect(await db('push_subscriptions').where({ user_id: user.id })).toHaveLength(0);
  });
});
