import type { CoreEntity, TimelineItem } from '@app/shared';
import type { Knex } from 'knex';
import { db } from '../../db/knex';
import type { AuthUser } from '../../http/context';
import { activitiesDef } from '../activities/activities.def';
import { contactsDef } from '../contacts/contacts.def';
import { dealsDef } from '../deals/deals.def';
import { can } from '../rbac/access';
import { customContext } from '../records/common';
import { scopedQuery } from '../records/service';
import type { ResourceDef } from '../records/types';
import { redactDiff } from '../records/custom';
import { userRefs } from '../records/hydrate';

/** Fields that are bookkeeping, or are shown elsewhere (stage moves), not as "changed X". */
const NOISE = new Set([
  'updated_at',
  'updated_by',
  'position',
  'stage_entered_at',
  'status',
  'won_at',
  'lost_at',
  'stage_id',
  'pipeline_id',
  'phone_e164',
  'full_name',
  'email_norm',
  'domain',
]);

/**
 * Records whose activities also belong on this record's timeline: a contact's deals, an organization's
 * contacts and deals. Limited to records the user may view, so notes on out-of-scope deals never leak.
 */
async function rolledUpIds(entity: CoreEntity, id: number, user: AuthUser) {
  const visible = async (def: ResourceDef, link: (qb: Knex.QueryBuilder) => void) => {
    if (!can(user, `${def.resource}.view`)) return [];
    const { qb } = await scopedQuery(def, user);
    link(qb);
    return (await qb.pluck(`${def.table}.id`)) as number[];
  };
  const deals = dealsDef as unknown as ResourceDef;
  const contacts = contactsDef as unknown as ResourceDef;
  if (entity === 'contact') {
    return { deal: await visible(deals, (qb) => qb.where('deals.contact_id', id)), contact: [] };
  }
  if (entity === 'organization') {
    return {
      deal: await visible(deals, (qb) => qb.where('deals.organization_id', id)),
      contact: await visible(contacts, (qb) =>
        qb.whereIn(
          'contacts.id',
          db('contact_organization').where('organization_id', id).select('contact_id'),
        ),
      ),
    };
  }
  return { deal: [], contact: [] };
}

export async function recordTimeline(
  entity: CoreEntity,
  row: Record<string, unknown>,
  user: AuthUser,
  opts: { kinds?: string; before?: string; limit: number },
): Promise<{ data: TimelineItem[] }> {
  const id = row.id as number;
  const kinds = opts.kinds ? new Set(opts.kinds.split(',')) : null;
  const want = (k: string) => !kinds || kinds.has(k);
  const before = opts.before ? new Date(opts.before) : new Date(Date.now() + 1000);
  const items: TimelineItem[] = [];
  const { levels } = await customContext(entity, user);

  // Activities on this record are visible to anyone who can see the record (decision D9).
  if (want('activity') && entity !== 'activity') {
    const related = await rolledUpIds(entity, id, user);
    const acts = await db('activities')
      .where((w) => {
        w.where({ related_type: entity, related_id: id });
        if (related.deal.length)
          w.orWhere((o) => o.where('related_type', 'deal').whereIn('related_id', related.deal));
        if (related.contact.length)
          w.orWhere((o) => o.where('related_type', 'contact').whereIn('related_id', related.contact));
      })
      .whereNull('deleted_at')
      .where('created_at', '<', before)
      .orderBy('created_at', 'desc')
      .limit(opts.limit);
    const dtos = await activitiesDef.toDtos(acts, { user, conn: db });
    for (const a of dtos) {
      items.push({
        id: `activity:${a.uuid}`,
        kind: 'activity',
        at: a.completedAt ?? a.createdAt,
        actor: a.owner,
        title: a.subject || a.type,
        activity: a,
      });
    }
  }

  const logs = await db('audit_logs')
    .where({ entity, entity_id: id })
    .where('created_at', '<', before)
    .orderBy('created_at', 'desc')
    .limit(opts.limit * 2);
  const actors = await userRefs(logs.map((l) => l.actor_id as number | null));
  for (const l of logs) {
    const actor = l.actor_id ? (actors.get(l.actor_id) ?? null) : null;
    const at = new Date(l.created_at).toISOString();
    const action = (l.action as string).split('.').pop();
    if (action === 'created' && want('created')) {
      items.push({ id: `audit:${l.id}`, kind: 'created', at, actor, title: 'created' });
    } else if (action === 'updated' && want('change')) {
      const diff = redactDiff((l.diff as Record<string, { from: unknown; to: unknown }>) ?? {}, levels);
      const fields = Object.entries(diff).filter(([k]) => !NOISE.has(k));
      if (fields.length)
        items.push({
          id: `audit:${l.id}`,
          kind: 'change',
          at,
          actor,
          title: 'updated',
          detail: Object.fromEntries(fields),
        });
    } else if (action === 'merged' && want('merged')) {
      items.push({ id: `audit:${l.id}`, kind: 'merged', at, actor, title: 'merged', detail: l.diff });
    } else if (action === 'uploaded' && want('file')) {
      items.push({ id: `audit:${l.id}`, kind: 'file', at, actor, title: 'uploaded a file', detail: l.diff });
    } else if ((action === 'deleted' || action === 'restored') && want('change')) {
      items.push({ id: `audit:${l.id}`, kind: 'change', at, actor, title: action });
    }
  }

  if (entity === 'deal' && want('stage')) {
    const moves = await db('deal_stage_history as h')
      .leftJoin('pipeline_stages as f', 'f.id', 'h.from_stage_id')
      .join('pipeline_stages as t', 't.id', 'h.to_stage_id')
      .where('h.deal_id', id)
      .where('h.changed_at', '<', before)
      .orderBy('h.changed_at', 'desc')
      .limit(opts.limit)
      .select('h.id', 'h.changed_at', 'h.changed_by', 'f.name as from_name', 't.name as to_name');
    const movers = await userRefs(moves.map((m) => m.changed_by as number | null));
    for (const m of moves) {
      items.push({
        id: `stage:${m.id}`,
        kind: 'stage',
        at: new Date(m.changed_at).toISOString(),
        actor: m.changed_by ? (movers.get(m.changed_by) ?? null) : null,
        title: m.from_name ? `moved from ${m.from_name} to ${m.to_name}` : `entered ${m.to_name}`,
        detail: { from: m.from_name, to: m.to_name },
      });
    }
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  return { data: items.slice(0, opts.limit) };
}
