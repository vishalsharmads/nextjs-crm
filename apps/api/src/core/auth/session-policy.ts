import type { Request } from 'express';
import type { ComplianceSettings } from '@app/shared';

/**
 * Milliseconds since the user last touched the keyboard or pointer, sent by the web client.
 * Background requests (polling, refresh) would otherwise keep an unattended session alive.
 * Clients that do not send it (API tools, tests) count as active.
 */
export const IDLE_HEADER = 'x-idle-ms';

/** Time of the last user activity this request implies. */
export function activityAt(req: Request): number {
  const raw = Number(req.get(IDLE_HEADER));
  const idle = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30 * 86_400_000) : 0;
  return Date.now() - idle;
}

export type SessionEnd = 'idle' | 'max_age';

/** Why the compliance session limits end this session, or null while it may continue. */
export function sessionEndReason(
  session: { last_used_at: Date | string; family_started_at: Date | string },
  compliance: Pick<ComplianceSettings, 'idleTimeoutMinutes' | 'sessionMaxHours'>,
  activity: number,
): SessionEnd | null {
  const now = Date.now();
  const last = Math.max(new Date(session.last_used_at).getTime(), activity);
  if (compliance.idleTimeoutMinutes > 0 && now - last > compliance.idleTimeoutMinutes * 60_000) return 'idle';
  if (
    compliance.sessionMaxHours > 0 &&
    now - new Date(session.family_started_at).getTime() > compliance.sessionMaxHours * 3_600_000
  )
    return 'max_age';
  return null;
}
