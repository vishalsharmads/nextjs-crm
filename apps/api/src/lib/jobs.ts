import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { db } from '../db/knex';
import { newUuid } from './ids';
import { AppError } from './errors';
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

/** Readiness: 'ok' when Redis answers, 'off' without Redis, 'unreachable' otherwise. */
export async function redisStatus(): Promise<'ok' | 'off' | 'unreachable'> {
  if (!usingRedis() || !queue) return 'off';
  try {
    // Narrow view of the Redis client, as for the locks below.
    const client = (await queue.client) as unknown as { ping(): Promise<string> };
    await Promise.race([
      client.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return 'ok';
  } catch {
    return 'unreachable';
  }
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
  // Claim the job: only one runner moves it from queued to running.
  const claimed = await db('jobs')
    .where({ id, status: 'queued' })
    .update({ status: 'running', started_at: new Date(), attempts: db.raw('attempts + 1') });
  if (!claimed) return;
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
      .update({ status: 'failed', error: publicJobError(err), finished_at: new Date() });
  }
}

export const JOB_FAILED_MESSAGE =
  'Something went wrong while this ran. Try again, or ask your administrator to check the server log.';
export const JOB_INTERRUPTED_MESSAGE = 'This stopped because the server restarted. Try again.';

/** Messages people may read: our own AppError text, never raw driver or library errors. */
function publicJobError(err: unknown): string {
  return err instanceof AppError ? err.message.slice(0, 2000) : JOB_FAILED_MESSAGE;
}

/**
 * Jobs a stopped process left behind: `running` for over an hour, or (without Redis, where the
 * queue lives in memory) `queued` for over ten minutes. They are marked failed so nobody waits forever.
 */
export async function recoverStaleJobs(now = new Date()) {
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const running = await db('jobs')
    .where({ status: 'running' })
    .where('started_at', '<', hourAgo)
    .update({ status: 'failed', error: JOB_INTERRUPTED_MESSAGE, finished_at: now });
  let queued = 0;
  if (!usingRedis())
    queued = await db('jobs')
      .where({ status: 'queued' })
      .where('created_at', '<', new Date(now.getTime() - 10 * 60_000))
      .update({ status: 'failed', error: JOB_INTERRUPTED_MESSAGE, finished_at: now });
  if (running || queued) logger.warn({ running, queued }, 'Marked interrupted jobs as failed');
  return { running, queued };
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
