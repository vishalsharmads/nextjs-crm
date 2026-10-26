import type { Request } from 'express';
import type { ComplianceSettings } from '@app/shared';

/**
 * Milliseconds since the user last touched the keyboard or pointer, sent by the web client.
 * It can only move `sessions.last_used_at` forward after the session has passed its limits;
 * it never decides expiry, so a missing or forged value cannot revive an idle session.
 * Background requests (polling, refresh) send the real idle time, so they do not count as activity.
 */
export const IDLE_HEADER = 'x-idle-ms';

/** Time of the last user input this request reports, or null when it reports none. */
export function activityAt(req: Request): number | null {
  const header = req.get(IDLE_HEADER);
  if (header === undefined || header === '') return null;
  const idle = Number(header);
  if (!Number.isFinite(idle) || idle < 0) return null;
  return Date.now() - Math.min(idle, 30 * 86_400_000);
}

export type SessionEnd = 'idle' | 'max_age';

/** Why the compliance session limits end this session (from stored times only), or null. */
export function sessionEndReason(
  session: { last_used_at: Date | string; family_started_at: Date | string },
  compliance: Pick<ComplianceSettings, 'idleTimeoutMinutes' | 'sessionMaxHours'>,
): SessionEnd | null {
  const now = Date.now();
  if (
    compliance.idleTimeoutMinutes > 0 &&
    now - new Date(session.last_used_at).getTime() > compliance.idleTimeoutMinutes * 60_000
  )
    return 'idle';
  if (
    compliance.sessionMaxHours > 0 &&
    now - new Date(session.family_started_at).getTime() > compliance.sessionMaxHours * 3_600_000
  )
    return 'max_age';
  return null;
}
