import { db } from '../db/knex';
import { newUuid } from './ids';
import { logger } from './logger';
import { isTest } from '../config/env';

/**
 * Job runner contract. Phase 1 runs jobs in-process and persists state in the `jobs` table;
 * Phase 2 swaps the transport for BullMQ without changing callers (same enqueue/handler API).
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

/** Recurring in-process tasks (reminders). Phase 2 moves these to BullMQ repeatable jobs. */
const timers: NodeJS.Timeout[] = [];
export function every(ms: number, name: string, fn: () => Promise<unknown>) {
  const tick = () =>
    fn().catch((err: unknown) => {
      logger.error({ err, task: name }, 'Scheduled task failed');
    });
  timers.push(setInterval(tick, ms));
}
export function stopSchedules() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
