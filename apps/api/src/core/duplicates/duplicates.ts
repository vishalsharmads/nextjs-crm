import {
  normalizePhone,
  type DuplicateCandidate,
  type DuplicateCheckResult,
  type DuplicateEntity,
  type DuplicatePairDto,
  type DuplicateRuleDto,
} from '@app/shared';
import { db, type Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { logger } from '../../lib/logger';
import type { AuthUser } from '../../http/context';
import { applyScope, can, scopeAllows } from '../rbac/access';
import { domainFromWebsite } from '../organizations/organizations.def';

/** Where each record type keeps the values a rule compares. */
const TYPES: Record<
  DuplicateEntity,
  {
    table: string;
    resource: string;
    title: string;
    subtitle: string;
    cols: Record<string, string>;
    /** Columns compared as text (empty strings never match). */
    text: string[];
    /** Rows that are no longer live people or companies. */
    live: (q: ReturnType<typeof db>, alias: string) => void;
  }
> = {
  contact: {
    table: 'contacts',
    resource: 'core.contacts',
    title: 'full_name',
    subtitle: 'email',
    // Contacts belong to organizations through contact_organization: '@org' is matched with a join.
    cols: { email: 'email_norm', phone: 'phone_e164', name: 'full_name', organization: '@org' },
    text: ['email_norm', 'phone_e164', 'full_name'],
    live: (q, a) => void q.whereNull(`${a}.deleted_at`),
  },
  organization: {
    table: 'organizations',
    resource: 'core.organizations',
    title: 'name',
    subtitle: 'domain',
    cols: { domain: 'domain', name: 'name' },
    text: ['domain', 'name'],
    live: (q, a) => void q.whereNull(`${a}.deleted_at`),
  },
  lead: {
    table: 'leads',
    resource: 'core.leads',
    title: 'full_name',
    subtitle: 'company_name',
    cols: { email: 'email_norm', phone: 'phone_e164', name: 'full_name', company: 'company_name' },
    text: ['email_norm', 'phone_e164', 'full_name', 'company_name'],
    // A converted lead lives on as its contact.
    live: (q, a) => void q.whereNull(`${a}.deleted_at`).whereNull(`${a}.converted_contact_id`),
  },
};

/** Contacts and leads describe the same people: email and phone rules look at both. */
const CROSS: Partial<Record<DuplicateEntity, DuplicateEntity>> = { contact: 'lead', lead: 'contact' };
const CROSS_FIELDS = new Set(['email', 'phone']);

/** Values to compare, keyed by rule field (`email`, `cf:member_no`…), already normalised. */
export type Probe = Record<string, string | number | null | undefined>;

interface RuleRow {
  id: number;
  uuid: string;
  entity: DuplicateEntity;
  name: string;
  fields: string[];
  action: 'warn' | 'block';
  active: number | boolean;
}

export async function activeRules(entity: DuplicateEntity, conn: Db = db): Promise<RuleRow[]> {
  return (await conn('duplicate_rules')
    .where({ entity, active: true })
    .orderBy(['position', 'id'])) as RuleRow[];
}

export const ruleDto = (r: RuleRow): DuplicateRuleDto => ({
  uuid: r.uuid,
  entity: r.entity,
  name: r.name,
  fields: r.fields,
  action: r.action,
  active: !!r.active,
});

/** Column for a rule field on a table, or null when this table cannot compare it. */
async function columnFor(entity: DuplicateEntity, field: string, conn: Db): Promise<string | null> {
  const t = TYPES[entity];
  if (!field.startsWith('cf:')) return t.cols[field] ?? null;
  const col = `cf_${field.slice(3)}`;
  if (!/^cf_[a-z][a-z0-9_]{0,48}$/.test(col)) return null;
  const exists = await conn('information_schema.columns')
    .where({ table_schema: conn.raw('DATABASE()'), table_name: t.table, column_name: col })
    .first();
  return exists ? col : null;
}

/** Normalise raw form values into a probe. */
export function probeFrom(input: {
  email?: unknown;
  phone?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  name?: unknown;
  website?: unknown;
  domain?: unknown;
  company?: unknown;
  organizationId?: number | null;
  organizationUuid?: unknown;
  custom?: Record<string, unknown> | null;
}): Probe {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const fullName =
    str([str(input.firstName), str(input.lastName)].filter(Boolean).join(' ')) ?? str(input.name);
  const probe: Probe = {
    email: str(input.email)?.toLowerCase() ?? null,
    phone: str(input.phone) ? normalizePhone(str(input.phone)!) || null : null,
    name: fullName,
    organization: input.organizationId ?? str(input.organizationUuid),
    domain: str(input.domain)?.toLowerCase() ?? domainFromWebsite(str(input.website)) ?? null,
    company: str(input.company),
  };
  for (const [k, v] of Object.entries(input.custom ?? {}))
    if (typeof v === 'string' || typeof v === 'number')
      probe[`cf:${k}`] = typeof v === 'string' ? v.trim() : v;
  return probe;
}

/** Probe values of a stored contact, organization or lead row. */
export function rowProbe(row: Record<string, unknown>) {
  return {
    email: row.email,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    name: row.name,
    domain: row.domain,
    company: row.company_name,
    organizationId: (row.organization_id as number | null | undefined) ?? null,
    custom: (row.custom as Record<string, unknown> | null) ?? null,
  };
}

interface Match {
  entity: DuplicateEntity;
  id: number;
  uuid: string;
  title: string;
  subtitle: string | null;
  ownerId: number | null;
  rules: RuleRow[];
}

/** Every live record that a rule of `entity` matches, whoever owns it. */
async function matchAll(
  entity: DuplicateEntity,
  probe: Probe,
  opts: { excludeId?: number; conn?: Db; onlyBlocking?: boolean } = {},
): Promise<Match[]> {
  const conn = opts.conn ?? db;
  const found = new Map<string, Match>();
  for (const rule of await activeRules(entity, conn)) {
    if (opts.onlyBlocking && rule.action !== 'block') continue;
    if (rule.fields.some((f) => probe[f] === null || probe[f] === undefined || probe[f] === '')) continue;
    const targets: DuplicateEntity[] = [entity];
    const cross = CROSS[entity];
    if (cross && !opts.onlyBlocking && rule.fields.every((f) => CROSS_FIELDS.has(f))) targets.push(cross);
    for (const target of targets) {
      const t = TYPES[target];
      const cols = await Promise.all(rule.fields.map((f) => columnFor(target, f, conn)));
      if (cols.some((c) => !c)) continue;
      const q = conn(`${t.table} as r`);
      t.live(q, 'r');
      for (const [i, c] of cols.entries()) {
        const value = probe[rule.fields[i]!] as string | number;
        if (c === '@org') {
          const orgId =
            typeof value === 'number'
              ? value
              : ((await conn('organizations').where({ uuid: value }).first('id'))?.id as number | undefined);
          q.whereExists((e) =>
            e
              .select(conn.raw('1'))
              .from('contact_organization as co')
              .whereRaw('co.contact_id = r.id')
              .where('co.organization_id', orgId ?? 0),
          );
        } else q.where(`r.${c}`, value);
      }
      if (opts.excludeId && target === entity) q.whereNot('r.id', opts.excludeId);
      const rows = (await q
        .limit(20)
        .select('r.id', 'r.uuid', `r.${t.title} as title`, `r.${t.subtitle} as subtitle`, 'r.owner_id')) as {
        id: number;
        uuid: string;
        title: string | null;
        subtitle: string | null;
        owner_id: number | null;
      }[];
      for (const r of rows) {
        const key = `${target}:${r.id}`;
        const m = found.get(key) ?? {
          entity: target,
          id: r.id,
          uuid: r.uuid,
          title: r.title || r.subtitle || '',
          subtitle: r.subtitle,
          ownerId: r.owner_id,
          rules: [],
        };
        m.rules.push(rule);
        found.set(key, m);
      }
    }
  }
  return [...found.values()];
}

async function visibleTo(user: AuthUser, m: Match): Promise<boolean> {
  const resource = TYPES[m.entity].resource;
  return can(user, `${resource}.view`) && scopeAllows(user, resource, [m.ownerId]);
}

/**
 * Possible duplicates of a record being created or viewed. Matches the person cannot open are
 * counted but never described (plan D3); `blocked` says a blocking rule would refuse the save.
 */
export async function checkDuplicates(
  user: AuthUser,
  entity: DuplicateEntity,
  probe: Probe,
  opts: { excludeId?: number; limit?: number } = {},
): Promise<DuplicateCheckResult> {
  const matches = await matchAll(entity, probe, { excludeId: opts.excludeId });
  const data: DuplicateCandidate[] = [];
  let hidden = 0;
  let blocked = false;
  for (const m of matches) {
    if (m.entity === entity && m.rules.some((r) => r.action === 'block')) blocked = true;
    if (!(await visibleTo(user, m))) {
      hidden++;
      continue;
    }
    data.push({
      uuid: m.uuid,
      title: m.title,
      subtitle: m.subtitle,
      reasons: m.rules.map((r) => r.name),
      score: m.rules.length * 40 + (m.rules.some((r) => r.action === 'block') ? 20 : 0),
      ...(m.entity !== entity ? { entity: m.entity } : {}),
    });
  }
  data.sort((a, b) => b.score - a.score);
  return { data: data.slice(0, opts.limit ?? 10), hidden, blocked };
}

/** Refuse a create (or an import row) that a blocking rule matches, without naming the record. */
export async function assertNotBlocked(entity: string, probe: Probe, conn: Db = db) {
  if (!(entity in TYPES)) return;
  const matches = await matchAll(entity as DuplicateEntity, probe, { conn, onlyBlocking: true });
  const rule = matches[0]?.rules.find((r) => r.action === 'block');
  if (rule)
    throw new AppError(
      'CONFLICT',
      `A matching record already exists (${rule.name}). Open it instead of creating another.`,
      {
        rule: rule.name,
      },
    );
}

// ---------- Scan and queue ----------

/** Find pairs that a rule matches and keep them for the merge queue. Returns how many are new. */
export async function scanDuplicates(entities: ('contact' | 'organization')[] = ['contact', 'organization']) {
  let added = 0;
  for (const entity of entities) {
    const t = TYPES[entity];
    for (const rule of await activeRules(entity)) {
      const cols = await Promise.all(rule.fields.map((f) => columnFor(entity, f, db)));
      if (cols.some((c) => !c)) continue;
      const plain = cols.filter((c) => c !== '@org');
      const q = db(`${t.table} as a`).join(`${t.table} as b`, function () {
        this.on('a.id', '<', 'b.id');
        for (const c of plain) this.andOn(`a.${c}`, '=', `b.${c}`);
      });
      if (cols.includes('@org'))
        q.join('contact_organization as ca', 'ca.contact_id', 'a.id').join(
          'contact_organization as cb',
          function () {
            this.on('cb.contact_id', '=', 'b.id').andOn('cb.organization_id', '=', 'ca.organization_id');
          },
        );
      t.live(q, 'a');
      t.live(q, 'b');
      for (const c of plain) {
        q.whereNotNull(`a.${c}`);
        if (t.text.includes(c!) || c!.startsWith('cf_')) q.whereNot(`a.${c}`, '');
      }
      const pairs = (await q.distinct('a.id as a', 'b.id as b').limit(2000)) as { a: number; b: number }[];
      for (let i = 0; i < pairs.length; i += 500) {
        const chunk = pairs.slice(i, i + 500);
        if (!chunk.length) continue;
        const before = Number(((await db('duplicate_pairs').count({ c: '*' }).first()) as { c: number }).c);
        await db('duplicate_pairs')
          .insert(chunk.map((p) => ({ uuid: newUuid(), entity, a_id: p.a, b_id: p.b, rule_id: rule.id })))
          .onConflict(['entity', 'a_id', 'b_id'])
          .ignore();
        const after = Number(((await db('duplicate_pairs').count({ c: '*' }).first()) as { c: number }).c);
        added += after - before;
      }
    }
  }
  if (added) logger.info({ added }, 'Duplicate scan found new pairs');
  return { added };
}

const mergeable = (user: AuthUser) =>
  (['contact', 'organization'] as const).filter((e) => can(user, `${TYPES[e].resource}.merge`));

/** Open pairs where the person may merge and can see both records. */
export async function listPairs(
  user: AuthUser,
  entity?: 'contact' | 'organization',
): Promise<DuplicatePairDto[]> {
  const out: DuplicatePairDto[] = [];
  for (const e of mergeable(user)) {
    if (entity && e !== entity) continue;
    const t = TYPES[e];
    const q = db('duplicate_pairs as p')
      .join(`${t.table} as a`, 'a.id', 'p.a_id')
      .join(`${t.table} as b`, 'b.id', 'p.b_id')
      .leftJoin('duplicate_rules as r', 'r.id', 'p.rule_id')
      .where({ 'p.entity': e, 'p.status': 'open' });
    t.live(q, 'a');
    t.live(q, 'b');
    await applyScope(q, user, t.resource, ['a.owner_id']);
    await applyScope(q, user, t.resource, ['b.owner_id']);
    const rows = await q
      .orderBy('p.id', 'desc')
      .limit(200)
      .select(
        'p.uuid',
        'p.created_at',
        'r.name as rule',
        'a.uuid as a_uuid',
        `a.${t.title} as a_title`,
        `a.${t.subtitle} as a_sub`,
        'b.uuid as b_uuid',
        `b.${t.title} as b_title`,
        `b.${t.subtitle} as b_sub`,
      );
    for (const r of rows)
      out.push({
        uuid: r.uuid,
        entity: e,
        rule: r.rule ?? null,
        a: { uuid: r.a_uuid, title: r.a_title || r.a_sub || '', subtitle: r.a_sub ?? null },
        b: { uuid: r.b_uuid, title: r.b_title || r.b_sub || '', subtitle: r.b_sub ?? null },
        createdAt: new Date(r.created_at).toISOString(),
      });
  }
  return out;
}

/** "Not a duplicate": the pair never comes back. */
export async function dismissPair(user: AuthUser, uuid: string) {
  const pair = await db('duplicate_pairs').where({ uuid, status: 'open' }).first();
  if (!pair || !mergeable(user).includes(pair.entity))
    throw new AppError('NOT_FOUND', 'That pair was not found');
  const visible = (await listPairs(user, pair.entity)).some((p) => p.uuid === uuid);
  if (!visible) throw new AppError('NOT_FOUND', 'That pair was not found');
  await db('duplicate_pairs')
    .where({ id: pair.id })
    .update({ status: 'dismissed', resolved_by: user.id, resolved_at: new Date() });
  return pair as { id: number; entity: string };
}

/** After a merge: pairs that involved the merged-away records are done. */
export async function closePairsAfterMerge(conn: Db, entity: string, userId: number, ids: number[]) {
  await conn('duplicate_pairs')
    .where({ entity, status: 'open' })
    .where((w) => w.whereIn('a_id', ids).orWhereIn('b_id', ids))
    .update({ status: 'merged', resolved_by: userId, resolved_at: new Date() });
}
