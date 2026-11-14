import { describe, expect, it } from 'vitest';
import { db } from '../src/db/knex';
import { newUuid } from '../src/lib/ids';
import { AppError } from '../src/lib/errors';
import {
  JOB_FAILED_MESSAGE,
  JOB_INTERRUPTED_MESSAGE,
  enqueue,
  recoverStaleJobs,
  registerJob,
} from '../src/lib/jobs';
import { productionConfigProblems } from '../src/config/env';
import { safeRequestId } from '../src/middleware/authenticate';

describe('operations', () => {
  it('stores a plain message instead of a raw library error, and keeps our own messages', async () => {
    registerJob('test.raw-fail', () =>
      Promise.reject(new Error("ER_DUP_ENTRY: Duplicate entry 'x' for key 'secret_idx'")),
    );
    registerJob('test.app-fail', () =>
      Promise.reject(new AppError('VALIDATION_FAILED', 'The file has no rows')),
    );
    const raw = await enqueue('test.raw-fail', {}, { wait: true });
    const own = await enqueue('test.app-fail', {}, { wait: true });
    expect((await db('jobs').where({ uuid: raw }).first()).error).toBe(JOB_FAILED_MESSAGE);
    expect((await db('jobs').where({ uuid: own }).first()).error).toBe('The file has no rows');
  });

  it('marks jobs a stopped process left behind as failed', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const running = newUuid();
    const queued = newUuid();
    const fresh = newUuid();
    await db('jobs').insert([
      { uuid: running, type: 'x', payload: '{}', status: 'running', started_at: old, created_at: old },
      { uuid: queued, type: 'x', payload: '{}', status: 'queued', created_at: old },
      { uuid: fresh, type: 'x', payload: '{}', status: 'running', started_at: new Date() },
    ]);
    await recoverStaleJobs();
    const rows = await db('jobs').whereIn('uuid', [running, queued, fresh]);
    const by = (u: string) => rows.find((r) => r.uuid === u);
    expect(by(running).status).toBe('failed');
    expect(by(running).error).toBe(JOB_INTERRUPTED_MESSAGE);
    expect(by(queued).status).toBe('failed');
    expect(by(fresh).status).toBe('running');
  });

  it('keeps only plain request ids', () => {
    expect(safeRequestId('abc-123')).toBe('abc-123');
    expect(safeRequestId('evil\nlevel=fatal')).not.toContain('\n');
    expect(safeRequestId('x'.repeat(65))).toHaveLength(36);
    expect(safeRequestId(undefined)).toHaveLength(36);
  });

  it('requires explicit production settings', () => {
    expect(productionConfigProblems({})).toEqual([
      'APP_URL must be set',
      'DATABASE_URL must be set',
      'SMTP_HOST must be set',
      'SMTP_PORT must be set',
      'MAIL_FROM must be set',
    ]);
    const ok = {
      APP_URL: 'https://crm.example.org',
      DATABASE_URL: 'mysql://u:p@127.0.0.1/crm',
      SMTP_HOST: 'smtp.example.org',
      SMTP_PORT: '587',
      MAIL_FROM: 'crm@example.org',
    };
    expect(productionConfigProblems(ok)).toEqual([]);
    expect(productionConfigProblems({ ...ok, APP_URL: 'http://localhost:5173' })).toEqual([
      'APP_URL must be the address people use, not localhost',
    ]);
  });
});
