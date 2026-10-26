import type { RequestContext } from '../../http/context';
import { db } from '../../db/knex';
import { logger } from '../../lib/logger';
import { effectiveCompliance } from '../settings/settings.service';
import { actorColumns } from './audit.service';

export type AccessAction = 'view' | 'download' | 'export' | 'reveal' | 'audit_view';

export interface AccessEntry {
  action: AccessAction;
  entity: string;
  entityId?: number | null;
  entityUuid?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Record a read of personal or health data (HIPAA §164.312(b), GDPR accountability) when the
 * workspace turns access logging on. Reads must not fail because logging failed, so errors are
 * logged instead of thrown.
 */
export async function logAccess(
  ctx: RequestContext,
  entry: AccessEntry,
  /** always: log whatever the setting; required: the read must not happen unless the log is written. */
  opts: { always?: boolean; required?: boolean } = {},
) {
  try {
    // Some reads (revealing a sensitive value) are logged whatever the setting.
    if (!opts.always && !(await effectiveCompliance()).accessLogging) return;
    await db('access_logs').insert({
      ...actorColumns(ctx),
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      entity_uuid: entry.entityUuid ?? null,
      detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
      ip: ctx.ip,
      user_agent: ctx.userAgent?.slice(0, 500) ?? null,
      request_id: ctx.requestId,
    });
  } catch (err) {
    logger.error({ err, action: entry.action, entity: entry.entity }, 'access log write failed');
    if (opts.required) throw err;
  }
}
