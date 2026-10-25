import type { Knex } from 'knex';
import type { Blueprint } from '@app/blueprints';
import { normalizePhone } from '@app/shared';
import { newUuid } from '../lib/ids';

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const DAY = 86_400_000;

/** `YYYY-MM-DD`, `days` from today (UTC). */
export const relativeDate = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/** A moment `days` from now at `hour`:00 UTC, so sample dates look current whenever a demo is reset. */
const relativeTime = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

/**
 * Replace `{{date:+7}}` / `{{date:-30}}` with a date relative to today, `{{datetime:+2@14:30}}` with an
 * ISO moment, and `{{<type>:<ref>}}` with the
 * value `lookup` returns (a record uuid). Walks objects and arrays; a string that is exactly one
 * placeholder becomes that value.
 */
export function fillPlaceholders(
  value: unknown,
  lookup: (type: string, ref: string) => string | undefined,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{([a-z_]+):([^}]+)\}\}/g, (whole, type: string, arg: string) => {
      if (type === 'date') return relativeDate(Number(arg));
      if (type === 'datetime') {
        // `+2@14:30`: two days from now at 14:30 UTC.
        const m = /^([+-]?\d+)(?:@(\d{1,2})(?::(\d{2}))?)?$/.exec(arg);
        if (!m) throw new Error(`Sample data: bad datetime ${whole}`);
        const d = relativeTime(Number(m[1]), Number(m[2] ?? 10));
        d.setUTCMinutes(Number(m[3] ?? 0));
        return d.toISOString();
      }
      const found = lookup(type, arg);
      if (found === undefined) throw new Error(`Sample data: unknown reference ${whole}`);
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, lookup));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, lookup)]));
  return value;
}

export interface SampleRefs {
  organization: Map<string, { id: number; uuid: string }>;
  contact: Map<string, { id: number; uuid: string }>;
  deal: Map<string, { id: number; uuid: string }>;
  lead: Map<string, { id: number; uuid: string }>;
}

/**
 * Insert demo records from a blueprint's `sample_data`: organizations, contacts, leads, deals and
 * activities. Records are owned by the user holding the role named in `owner` (demo users), else spread
 * across active users. `days` backdates a record. Returns the count and the refs for module requests.
 */
export async function seedSampleData(
  knex: Knex,
  bp: Blueprint,
): Promise<{ count: number; refs: SampleRefs }> {
  const refs: SampleRefs = { organization: new Map(), contact: new Map(), deal: new Map(), lead: new Map() };
  const sample = bp.sample_data;
  if (!sample) return { count: 0, refs };
  // Dates only here; record references are for `requests`, which run later with the uuids known.
  const { requests, ...core } = sample;
  const data = { ...(fillPlaceholders(core, () => undefined) as typeof core), requests };
  const count = await knex.transaction(async (trx) => {
    const users = (await trx('users as u')
      .join('user_roles as ur', 'ur.user_id', 'u.id')
      .join('roles as r', 'r.id', 'ur.role_id')
      .where('u.status', 'active')
      .whereNull('u.deleted_at')
      .orderBy('u.id')
      .select('u.id', 'r.key as role')) as { id: number; role: string }[];
    const adminId = users.find((u) => u.role === 'admin')?.id ?? users[0]?.id ?? null;
    let turn = 0;
    const owner = (row: Record<string, unknown>) => {
      const role = str(row.owner);
      if (role) return users.find((u) => u.role === role)?.id ?? adminId;
      return users.length ? users[turn++ % users.length]!.id : adminId;
    };
    const at = (row: Record<string, unknown>) => relativeTime(num(row.days) ?? 0, 9);
    const general = (await trx('settings').where({ key: 'general' }).first())?.value as
      { currency?: string } | undefined;
    const currency = general?.currency ?? 'USD';
    const remember = (
      map: Map<string, { id: number; uuid: string }>,
      row: Record<string, unknown>,
      id: number,
      uuid: string,
    ) => {
      if (str(row.ref)) map.set(str(row.ref)!, { id, uuid });
    };
    let n = 0;

    for (const o of data.organizations) {
      const website = str(o.website);
      const uuid = newUuid();
      const ownerId = owner(o);
      const [id] = await trx('organizations').insert({
        uuid,
        name: str(o.name) ?? 'Organization',
        website,
        domain: website ? new URL(website).hostname.replace(/^www\./, '') : null,
        industry: str(o.industry),
        owner_id: ownerId,
        created_by: ownerId,
        created_at: at(o),
        custom: JSON.stringify(o.custom ?? {}),
      });
      remember(refs.organization, o, id!, uuid);
      n++;
    }

    for (const c of data.contacts) {
      const phone = str(c.phone);
      const uuid = newUuid();
      const ownerId = owner(c);
      const [id] = await trx('contacts').insert({
        uuid,
        first_name: str(c.first_name) ?? '',
        last_name: str(c.last_name) ?? '',
        email: str(c.email),
        phone,
        phone_e164: phone ? normalizePhone(phone) : null,
        job_title: str(c.job_title),
        lifecycle_status: str(c.lifecycle_status),
        source: str(c.source),
        owner_id: ownerId,
        created_by: ownerId,
        created_at: at(c),
        custom: JSON.stringify(c.custom ?? {}),
      });
      remember(refs.contact, c, id!, uuid);
      const org = str(c.organization) ? refs.organization.get(str(c.organization)!) : undefined;
      if (org)
        await trx('contact_organization').insert({
          uuid: newUuid(),
          contact_id: id,
          organization_id: org.id,
          is_primary: true,
        });
      n++;
    }

    for (const l of data.leads) {
      const phone = str(l.phone);
      const uuid = newUuid();
      const ownerId = owner(l);
      const [id] = await trx('leads').insert({
        uuid,
        first_name: str(l.first_name) ?? '',
        last_name: str(l.last_name) ?? '',
        email: str(l.email),
        phone,
        phone_e164: phone ? normalizePhone(phone) : null,
        company_name: str(l.company_name),
        job_title: str(l.job_title),
        source: str(l.source),
        status: str(l.status) ?? 'new',
        owner_id: ownerId,
        created_by: ownerId,
        created_at: at(l),
        custom: JSON.stringify(l.custom ?? {}),
      });
      remember(refs.lead, l, id!, uuid);
      n++;
    }

    const pipeline = await trx('pipelines').where({ entity: 'deal', is_default: true }).first();
    if (pipeline) {
      const stages = await trx('pipeline_stages').where({ pipeline_id: pipeline.id }).orderBy('sort_order');
      for (const [i, d] of data.deals.entries()) {
        const stage = stages.find((s) => s.key === d.stage) ?? stages[0];
        if (!stage) continue;
        const status = stage.is_won ? 'won' : stage.is_lost ? 'lost' : 'open';
        const created = at(d);
        const entered = relativeTime(num(d.stage_days) ?? Math.min((num(d.days) ?? 0) + 2, 0), 11);
        const uuid = newUuid();
        const ownerId = owner(d);
        const [id] = await trx('deals').insert({
          uuid,
          title: str(d.title) ?? 'Deal',
          contact_id: str(d.contact) ? (refs.contact.get(str(d.contact)!)?.id ?? null) : null,
          organization_id: str(d.organization)
            ? (refs.organization.get(str(d.organization)!)?.id ?? null)
            : null,
          pipeline_id: pipeline.id,
          stage_id: stage.id,
          value: num(d.value) ?? 0,
          currency,
          expected_close: str(d.expected_close),
          status,
          won_at: status === 'won' ? entered : null,
          lost_at: status === 'lost' ? entered : null,
          lost_reason: status === 'lost' ? str(d.lost_reason) : null,
          stage_entered_at: entered,
          owner_id: ownerId,
          created_by: ownerId,
          created_at: created,
          position: (i + 1) * 1000,
          custom: JSON.stringify(d.custom ?? {}),
        });
        remember(refs.deal, d, id!, uuid);
        n++;
      }
    }

    for (const a of data.activities) {
      const [type, ref] = (str(a.related) ?? '').split(':') as [keyof SampleRefs | '', string | undefined];
      const related = type && ref ? refs[type]?.get(ref) : undefined;
      if (str(a.related) && !related)
        throw new Error(`Sample activity: unknown related record "${a.related}"`);
      const kind = str(a.type) ?? 'note';
      const created = at(a);
      const due = num(a.due_days) !== null ? relativeTime(num(a.due_days)!, num(a.hour) ?? 10) : null;
      const done = kind === 'note' || a.done === true;
      const ownerId = owner(a);
      await trx('activities').insert({
        uuid: newUuid(),
        type: kind,
        subject: str(a.subject) ?? '',
        body: str(a.body),
        due_at: kind === 'task' || kind === 'call' ? due : null,
        start_at: kind === 'meeting' ? due : null,
        end_at: kind === 'meeting' && due ? new Date(due.getTime() + 3_600_000) : null,
        completed_at: done ? (due && due < new Date() ? due : created) : null,
        priority: str(a.priority) ?? 'normal',
        outcome: str(a.outcome),
        owner_id: ownerId,
        assignee_id: ownerId,
        related_type: related ? type : null,
        related_id: related?.id ?? null,
        created_by: ownerId,
        created_at: created,
        custom: JSON.stringify({}),
      });
      n++;
    }
    return n;
  });
  return { count, refs };
}
