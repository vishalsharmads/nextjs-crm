import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../db/knex';
import { defineRoutes } from '../../http/routes';
import { decrypt, encrypt } from '../../lib/crypto';
import { enqueue, registerJob } from '../../lib/jobs';
import { logger } from '../../lib/logger';
import { assertSafeUrl } from '../webhooks/webhooks';

const AAD = 'push_vapid.private_key_enc';

/** The workspace's VAPID key pair, created on first use. */
async function vapid(): Promise<{ publicKey: string; privateKey: string }> {
  const row = await db('push_vapid').orderBy('id').first();
  if (row) return { publicKey: row.public_key, privateKey: decrypt(row.private_key_enc, AAD) };
  const keys = webpush.generateVAPIDKeys();
  await db('push_vapid').insert({
    public_key: keys.publicKey,
    private_key_enc: encrypt(keys.privateKey, AAD),
  });
  // Two processes may race on the very first use: whichever row is first wins for everyone.
  const first = await db('push_vapid').orderBy('id').first();
  return { publicKey: first.public_key, privateKey: decrypt(first.private_key_enc, AAD) };
}

const hash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

export interface PushMessage {
  title: string;
  body?: string;
  link?: string;
  tag?: string;
}

interface Subscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** How a message reaches a push service; tests replace it. */
export const pushTransport: {
  send: (
    sub: Subscription,
    payload: string,
    keys: { publicKey: string; privateKey: string },
  ) => Promise<void>;
} = {
  async send(sub, payload, keys) {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      {
        TTL: 3600,
        timeout: 10_000,
        vapidDetails: {
          subject: `mailto:${env.MAIL_FROM}`,
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
      },
    );
  },
};

/** Queue a push to every browser the person subscribed. Nothing happens without subscriptions. */
export async function queuePush(userId: number, message: PushMessage) {
  const any = await db('push_subscriptions').where({ user_id: userId }).first('id');
  if (!any) return;
  await enqueue('push.send', { userId, message: message as unknown as Record<string, unknown> });
}

registerJob('push.send', async (job) => {
  const userId = job.payload.userId as number;
  const message = job.payload.message as PushMessage;
  const subs = (await db('push_subscriptions').where({ user_id: userId })) as Subscription[];
  if (!subs.length) return;
  const keys = await vapid();
  const payload = JSON.stringify(message);
  for (const sub of subs) {
    try {
      await pushTransport.send(sub, payload, keys);
      await db('push_subscriptions').where({ id: sub.id }).update({ last_used_at: new Date() });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // Gone or not found: the browser unsubscribed or was reset.
      if (status === 404 || status === 410) await db('push_subscriptions').where({ id: sub.id }).delete();
      else logger.warn({ err: (err as Error).message, status }, 'Push failed');
    }
  }
});

const subscriptionSchema = z.object({
  // Push services are always https.
  endpoint: z.url({ protocol: /^https$/ }).max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
});

export const pushRoutes = defineRoutes('/me/push', ['me'])
  .add({
    method: 'get',
    path: '/key',
    permission: 'authenticated',
    summary: 'The public key browsers use to subscribe to push notifications',
    handler: async () => ({ publicKey: (await vapid()).publicKey }),
  })
  .add({
    method: 'get',
    path: '/subscriptions',
    permission: 'authenticated',
    handler: async ({ user }) => ({
      count: Number(
        (
          (await db('push_subscriptions').where({ user_id: user.id }).count({ c: '*' }).first()) as {
            c: number;
          }
        ).c,
      ),
    }),
  })
  .add({
    method: 'post',
    path: '/subscriptions',
    permission: 'authenticated',
    body: subscriptionSchema,
    status: 204,
    summary: 'Receive push notifications in this browser',
    handler: async ({ req, user, body }) => {
      // Push services are public https endpoints; never let a subscription point inside the network.
      await assertSafeUrl(body.endpoint, 'endpoint');
      await db('push_subscriptions')
        .insert({
          user_id: user.id,
          endpoint: body.endpoint,
          endpoint_hash: hash(body.endpoint),
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          user_agent: (req.get('user-agent') ?? '').slice(0, 255) || null,
        })
        .onConflict('endpoint_hash')
        .merge(['user_id', 'p256dh', 'auth', 'user_agent']);
    },
  })
  .add({
    method: 'post',
    path: '/subscriptions/remove',
    permission: 'authenticated',
    body: z.object({ endpoint: z.url().max(2000) }),
    status: 204,
    summary: 'Stop push notifications in this browser',
    handler: async ({ user, body }) => {
      await db('push_subscriptions')
        .where({ user_id: user.id, endpoint_hash: hash(body.endpoint) })
        .delete();
    },
  });
