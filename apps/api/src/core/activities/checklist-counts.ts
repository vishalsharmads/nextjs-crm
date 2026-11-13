import { db, type Db } from '../../db/knex';

/** Checklist progress for many activities at once, for list and board DTOs. */
export async function checklistCounts(
  activityIds: number[],
  conn: Db = db,
): Promise<Map<number, { done: number; total: number }>> {
  const out = new Map<number, { done: number; total: number }>();
  if (!activityIds.length) return out;
  const rows = await conn('activity_checklist_items')
    .whereIn('activity_id', activityIds)
    .groupBy('activity_id')
    .select('activity_id')
    .count('* as total')
    .select(conn.raw('SUM(done_at IS NOT NULL) as done'));
  for (const r of rows)
    out.set(r.activity_id as number, { done: Number(r.done ?? 0), total: Number(r.total ?? 0) });
  return out;
}
