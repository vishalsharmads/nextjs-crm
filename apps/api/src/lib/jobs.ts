import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { db } from '../db/knex';
import { newUuid } from './ids';
import { logger } from './logger';
import { env, isTest } from '../config/env';

/**
 * Background jobs. State always lives in the `jobs` table (status, progress, result).
 * Transport: BullMQ on Redis when REDIS_URL is set, otherwise in-process. Callers do not change.
 */
export type JobHandler = (
  job: { id: number; uuid: string; payload: Record<string, unknown> },
  progress: (pct: number) => Promise<void>,
) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export interface EnqueueOptions {
  createdBy?: number | null;
  /** Run synchronously and await completion (tests, small jobs). */
  wait?: boolean;
}

// ---------- Transport ----------

const QUEUE = 'crm-jobs';
let queue: Queue | null = null;
let worker: Worker | null = null;

function redisConnection(): ConnectionOptions {
  const u = new URL(env.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: Number(u.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
  };
}

export const usingRedis = () => !!env.REDIS_URL && !isTest;

/** Start the BullMQ worker (in the API process; a dedicated worker process can call this too). */
export function startJobWorker() {
  if (!usingRedis() || worker) return;
  const connection = redisConnection();
  queue = new Queue(QUEUE, { connection });
  worker = new Worker(
    QUEUE,
    async (job) => {
      const { jobId, uuid, type, payload } = job.data as {
        jobId: number;
        uuid: string;
        type: string;
        payload: Record<string, unknown>;
      };
      await runJob(jobId, uuid, type, payload);
    },
    { connection, concurrency: 5 },
  );
  worker.on('failed', (job, err) => logger.error({ err, job: job?.id }, 'Queued job failed'));
  logger.info('Background jobs use Redis (BullMQ)');
}

export async function stopJobWorker() {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}

export async function enqueue(
  type: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string> {
  const uuid = newUuid();
  const [id] = await db('jobs').insert({
    uuid,
    type,
    payload: JSON.stringify(payload),
    status: 'queued',
    created_by: opts.createdBy ?? null,
  });
  const run = () => runJob(id!, uuid, type, payload);
  if (opts.wait || isTest) await run();
  else if (queue)
    await queue.add(
      type,
      { jobId: id, uuid, type, payload },
      { jobId: uuid, removeOnComplete: 1000, removeOnFail: 5000 },
    );
  else setImmediate(() => void run());
  return uuid;
}

async function runJob(id: number, uuid: string, type: string, payload: Record<string, unknown>) {
  const handler = handlers.get(type);
  if (!handler) {
    await db('jobs')
      .where({ id })
      .update({ status: 'failed', error: `No handler for ${type}`, finished_at: new Date() });
    return;
  }
  await db('jobs')
    .where({ id })
    .update({ status: 'running', started_at: new Date(), attempts: db.raw('attempts + 1') });
  try {
    const result = await handler({ id, uuid, payload }, async (pct) => {
      await db('jobs')
        .where({ id })
        .update({ progress: Math.max(0, Math.min(100, Math.round(pct))) });
    });
    await db('jobs')
      .where({ id })
      .update({
        status: 'succeeded',
        progress: 100,
        result: JSON.stringify(result ?? null),
        finished_at: new Date(),
      });
  } catch (err) {
    logger.error({ err, job: uuid, type }, 'Job failed');
    await db('jobs')
      .where({ id })
      .update({ status: 'failed', error: (err as Error).message.slice(0, 2000), finished_at: new Date() });
  }
}

// ---------- Recurring tasks ----------

interface RedisLock {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
}

const timers: NodeJS.Timeout[] = [];

/**
 * Run `fn` every `ms`. With Redis, a short lock per tick makes each task run on exactly one
 * process even when several API processes are deployed.
 */
export function every(ms: number, name: string, fn: () => Promise<unknown>) {
  const tick = async () => {
    try {
      if (queue) {
        // Narrow view of the Redis client: SET key value PX ttl NX (atomic lock).
        const client = (await queue.client) as unknown as RedisLock;
        const ok = await client.set(
          `crm:schedule:${name}`,
          String(process.pid),
          'PX',
          Math.max(ms - 1000, 1000),
          'NX',
        );
        if (!ok) return;
      }
      await fn();
    } catch (err) {
      logger.error({ err, task: name }, 'Scheduled task failed');
    }
  };
  timers.push(setInterval(() => void tick(), ms));
}

export function stopSchedules() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
