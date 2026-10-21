import type { RequestContext } from '../../http/context';
import type { Db } from '../../db/knex';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: number | null;
  entityUuid?: string | null;
  diff?: unknown;
}

/** Append an audit row. Call inside the same transaction as the change it records. */
export async function audit(conn: Db, ctx: RequestContext, entry: AuditEntry) {
  await conn('audit_logs').insert({
    actor_id: ctx.user?.id ?? null,
    actor_type: ctx.user?.apiKeyId
      ? 'api_key'
      : ctx.user
        ? 'user'
        : ctx.requestId.startsWith('cli')
          ? 'cli'
          : 'system',
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entityId ?? null,
    entity_uuid: entry.entityUuid ?? null,
    diff: entry.diff === undefined ? null : JSON.stringify(entry.diff),
    ip: ctx.ip,
    user_agent: ctx.userAgent?.slice(0, 500) ?? null,
    request_id: ctx.requestId,
  });
}

/** Field-level diff between two flat records (custom JSON is diffed one level deep). */
export function diffRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === 'updated_at' || k === 'updated_by') continue;
    const a = before[k];
    const b = after[k];
    if (k === 'custom' && isObj(a) && isObj(b)) {
      for (const [ck, cv] of Object.entries(diffRecords(a, b))) out[`custom.${ck}`] = cv;
      continue;
    }
    if (JSON.stringify(norm(a)) !== JSON.stringify(norm(b))) out[k] = { from: a ?? null, to: b ?? null };
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));
