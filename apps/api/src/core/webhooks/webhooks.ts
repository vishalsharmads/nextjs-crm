import { toPatch } from '@app/shared';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod';
import { env } from '../../config/env';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { decrypt, encrypt, hmac, randomToken } from '../../lib/crypto';
import { newUuid } from '../../lib/ids';
import { logger } from '../../lib/logger';
import { enqueue, every, registerJob } from '../../lib/jobs';
import { audit } from '../audit/audit.service';
import { eventTouchesRestricted } from '../privacy/privacy.service';
import { effectiveCompliance } from '../settings/settings.service';
import { EVENT_TYPES, onEvent, type DomainEvent } from '../events/events';

const MAX_ATTEMPTS = 6;
const BACKOFF_MIN = [0, 1, 5, 30, 120, 720];

// ---------- SSRF guard ----------

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === '::1' ||
    v6 === '::' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('::ffff:127.') ||
    v6.startsWith('::ffff:10.') ||
    v6.startsWith('::ffff:192.168.')
  );
}

/** Webhook targets must be https (or http in dev) and must not resolve to internal addresses. */
export async function assertSafeUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Enter a valid URL', [{ path: 'url', message: 'Invalid URL' }]);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.WEBHOOKS_ALLOW_PRIVATE)) {
    throw new AppError('VALIDATION_FAILED', 'Webhook URLs must use https', [
      { path: 'url', message: 'Use https' },
    ]);
  }
  if (env.WEBHOOKS_ALLOW_PRIVATE) return;
  const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) {
    throw new AppError('VALIDATION_FAILED', 'This address is not reachable from the internet', [
      { path: 'url', message: 'Private or unknown host' },
    ]);
  }
}

// ---------- Delivery ----------

export function sign(secret: string, timestamp: string, body: string) {
  return `sha256=${hmac(secret, `${timestamp}.${body}`)}`;
}

async function deliver(deliveryId: number) {
  const d = await db('webhook_deliveries as d')
    .join('webhooks as w', 'w.id', 'd.webhook_id')
    .where('d.id', deliveryId)
    .first('d.*', 'w.url', 'w.secret_enc', 'w.active', 'w.id as wid');
  if (!d || d.status !== 'pending' || !d.active) return;
  const body = JSON.stringify(d.payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const attempts = d.attempts + 1;
  let status: number | null = null;
  let error: string | null = null;
  try {
    await assertSafeUrl(d.url);
    const res = await fetch(d.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'webhooks/1',
        'X-Webhook-Id': d.uuid,
        'X-Webhook-Event': d.event,
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': sign(decrypt(d.secret_enc), timestamp, body),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message.slice(0, 900);
  }
  if (!error) {
    await db('webhook_deliveries').where({ id: d.id }).update({
      status: 'succeeded',
      attempts,
      response_status: status,
      error: null,
      delivered_at: new Date(),
      next_attempt_at: null,
    });
    await db('webhooks').where({ id: d.wid }).update({ failure_count: 0 });
    return;
  }
  const giveUp = attempts >= MAX_ATTEMPTS;
  await db('webhook_deliveries')
    .where({ id: d.id })
    .update({
      status: giveUp ? 'failed' : 'pending',
      attempts,
      response_status: status,
      error,
      next_attempt_at: giveUp ? null : new Date(Date.now() + (BACKOFF_MIN[attempts] ?? 720) * 60_000),
    });
  await db('webhooks').where({ id: d.wid }).increment('failure_count', 1);
  // Endpoints that keep failing are switched off so they stop consuming retries.
  const wh = await db('webhooks').where({ id: d.wid }).first('failure_count');
  if (wh && wh.failure_count >= 50) await db('webhooks').where({ id: d.wid }).update({ active: false });
}

registerJob('webhook.deliver', async (job) => {
  await deliver(job.payload.deliveryId as number);
});

/** Fan out every domain event to subscribed, active webhooks. */
onEvent(async (e: DomainEvent) => {
  // GDPR Art. 18: do not pass a restricted record on to other systems.
  if (await eventTouchesRestricted(e)) return;
  const hooks = await db('webhooks').where({ active: true });
  const minimal = hooks.length ? (await effectiveCompliance()).webhookMinimal : false;
  for (const h of hooks) {
    const events = h.events as string[];
    if (!events.includes('*') && !events.includes(e.type)) continue;
    const uuid = newUuid();
    // Minimal mode (forced by the health data profile): no personal data leaves in webhooks.
    const data = minimal
      ? {
          entity: e.entity,
          uuid: e.uuid, // Custom field names can themselves be telling (a "diagnosis" changed): report "custom" only.
          changedFields: [
            ...new Set(Object.keys(e.changes ?? {}).map((k) => (k.startsWith('custom.') ? 'custom' : k))),
          ],
        }
      : { entity: e.entity, uuid: e.uuid, record: e.record, changes: e.changes ?? null };
    const payload = { id: uuid, type: e.type, createdAt: e.at, data };
    const [id] = await db('webhook_deliveries').insert({
      uuid,
      webhook_id: h.id,
      event: e.type,
      payload: JSON.stringify(payload),
      next_attempt_at: new Date(),
    });
    await enqueue('webhook.deliver', { deliveryId: id });
  }
});

/** Retry due deliveries (every minute, alongside reminders). */
export async function retryDueWebhooks() {
  const due = await db('webhook_deliveries')
    .where({ status: 'pending' })
    .where('attempts', '>', 0)
    .where('next_attempt_at', '<=', new Date())
    .limit(100)
    .pluck('id');
  for (const id of due as number[])
    await deliver(id).catch((err: unknown) => logger.warn({ err }, 'Webhook retry failed'));
}
export const startWebhookRetries = () => every(60_000, 'webhook-retries', retryDueWebhooks);

// ---------- Admin API ----------

const body = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.url().max(2000),
  events: z.array(z.union([z.enum(EVENT_TYPES), z.literal('*')])).min(1),
  active: z.boolean().default(true),
});

const dto = (w: Record<string, unknown>) => ({
  uuid: w.uuid,
  name: w.name,
  url: w.url,
  events: w.events,
  active: !!w.active,
  failureCount: w.failure_count,
  createdAt: new Date(w.created_at as string).toISOString(),
});

export const webhooksRoutes = defineRoutes('/webhooks', ['webhooks'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.webhooks.manage',
    handler: async () => ({
      data: (await db('webhooks').orderBy('id', 'desc')).map(dto),
      events: EVENT_TYPES,
    }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.webhooks.manage',
    body,
    status: 201,
    handler: async ({ ctx, user, body: b }) => {
      await assertSafeUrl(b.url);
      const secret = `whsec_${randomToken(24)}`;
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('webhooks').insert({
          uuid,
          name: b.name,
          url: b.url,
          events: JSON.stringify(b.events),
          secret_enc: encrypt(secret),
          active: b.active,
          created_by: user.id,
        });
        await audit(trx, ctx, {
          action: 'webhook.created',
          entity: 'webhook',
          entityId: id,
          entityUuid: uuid,
          diff: { name: b.name, url: b.url, events: b.events },
        });
      });
      return { ...dto(await db('webhooks').where({ uuid }).first()), secret };
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.webhooks.manage',
    params: z.object({ uuid: z.uuid() }),
    body: toPatch(body),
    handler: async ({ ctx, params, body: b }) => {
      const w = await db('webhooks').where({ uuid: params.uuid }).first();
      if (!w) throw notFound('Webhook');
      if (b.url) await assertSafeUrl(b.url);
      await db.transaction(async (trx) => {
        await trx('webhooks')
          .where({ id: w.id })
          .update({
            ...(b.name ? { name: b.name } : {}),
            ...(b.url ? { url: b.url } : {}),
            ...(b.events ? { events: JSON.stringify(b.events) } : {}),
            ...(b.active !== undefined ? { active: b.active, failure_count: 0 } : {}),
          });
        await audit(trx, ctx, {
          action: 'webhook.updated',
          entity: 'webhook',
          entityId: w.id,
          entityUuid: params.uuid,
          diff: b,
        });
      });
      return dto(await db('webhooks').where({ id: w.id }).first());
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.webhooks.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, params }) => {
      const n = await db('webhooks').where({ uuid: params.uuid }).delete();
      if (!n) throw notFound('Webhook');
      await audit(db, ctx, { action: 'webhook.deleted', entity: 'webhook', entityUuid: params.uuid });
    },
  })
  .add({
    method: 'get',
    path: '/:uuid/deliveries',
    permission: 'core.webhooks.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ params }) => {
      const w = await db('webhooks').where({ uuid: params.uuid }).first('id');
      if (!w) throw notFound('Webhook');
      const rows = await db('webhook_deliveries').where({ webhook_id: w.id }).orderBy('id', 'desc').limit(50);
      return {
        data: rows.map((r) => ({
          uuid: r.uuid,
          event: r.event,
          status: r.status,
          attempts: r.attempts,
          responseStatus: r.response_status,
          error: r.error,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/test',
    permission: 'core.webhooks.manage',
    params: z.object({ uuid: z.uuid() }),
    summary: 'Send a ping event now',
    handler: async ({ params }) => {
      const w = await db('webhooks').where({ uuid: params.uuid }).first();
      if (!w) throw notFound('Webhook');
      const uuid = newUuid();
      const [id] = await db('webhook_deliveries').insert({
        uuid,
        webhook_id: w.id,
        event: 'ping',
        payload: JSON.stringify({ id: uuid, type: 'ping', createdAt: new Date().toISOString(), data: {} }),
      });
      await deliver(id!);
      const d = await db('webhook_deliveries').where({ id }).first();
      return { status: d.status, responseStatus: d.response_status, error: d.error };
    },
  });
