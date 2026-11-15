import type { Knex } from 'knex';
import type { ParticipantDto, ParticipantKind, ParticipantRole, RelatedType } from '@app/shared';
import type { AuthUser } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { applyScope, can } from '../rbac/access';

/** Tables and name columns of the record kinds that can take part in an activity. */
const KINDS: Record<Exclude<ParticipantKind, 'user'>, { table: string; title: string; resource: string }> = {
  contact: { table: 'contacts', title: 'full_name', resource: 'core.contacts' },
  lead: { table: 'leads', title: 'full_name', resource: 'core.leads' },
  organization: { table: 'organizations', title: 'name', resource: 'core.organizations' },
};

export interface ParticipantRow {
  kind: ParticipantKind;
  record_id: number;
  role: ParticipantRole;
}

/**
 * Turn `{ kind, uuid, role }` inputs into rows. Records must be visible to the writer (missing and
 * out of scope look the same); colleagues must be active users.
 */
export async function resolveParticipants(
  conn: Db,
  user: AuthUser,
  input: { kind: ParticipantKind; uuid: string; role: ParticipantRole }[],
): Promise<ParticipantRow[]> {
  const out = new Map<string, ParticipantRow>();
  for (const p of input) {
    let id: number | undefined;
    if (p.kind === 'user') {
      id = (await conn('users').where({ uuid: p.uuid, status: 'active' }).whereNull('deleted_at').first('id'))
        ?.id as number | undefined;
    } else {
      const meta = KINDS[p.kind];
      const qb = conn(meta.table).where(`${meta.table}.uuid`, p.uuid).whereNull(`${meta.table}.deleted_at`);
      await applyScope(qb, user, meta.resource, [`${meta.table}.owner_id`], conn);
      if (can(user, `${meta.resource}.view`))
        id = (await qb.first(`${meta.table}.id`))?.id as number | undefined;
    }
    if (!id)
      throw new AppError('VALIDATION_FAILED', 'A participant was not found', [
        { path: 'participants', message: `${p.kind} not found` },
      ]);
    out.set(`${p.kind}:${id}`, { kind: p.kind, record_id: id, role: p.role });
  }
  return [...out.values()];
}

/** Replace an activity's participants. */
export async function setParticipants(conn: Db, activityId: number, rows: ParticipantRow[]) {
  await conn('activity_participants').where({ activity_id: activityId }).delete();
  if (rows.length)
    await conn('activity_participants').insert(rows.map((r) => ({ activity_id: activityId, ...r })));
}

/** Add participants, keeping existing ones. */
export async function addParticipants(conn: Db, activityId: number, rows: ParticipantRow[]) {
  if (!rows.length) return;
  await conn('activity_participants')
    .insert(rows.map((r) => ({ activity_id: activityId, ...r })))
    .onConflict(['activity_id', 'kind', 'record_id'])
    .ignore();
}

/** Participants of many activities, by activity id. */
export async function participantsOf(
  conn: Db,
  activityIds: number[],
): Promise<Map<number, ParticipantDto[]>> {
  const out = new Map<number, ParticipantDto[]>();
  if (!activityIds.length) return out;
  const rows = (await conn('activity_participants')
    .whereIn('activity_id', activityIds)
    .orderBy('id')) as (ParticipantRow & {
    activity_id: number;
  })[];
  const names = new Map<string, { uuid: string; name: string }>();
  const byKind = (k: ParticipantKind) => [
    ...new Set(rows.filter((r) => r.kind === k).map((r) => r.record_id)),
  ];
  for (const kind of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
    const ids = byKind(kind);
    if (!ids.length) continue;
    const meta = KINDS[kind];
    for (const r of await conn(meta.table).whereIn('id', ids).select('id', 'uuid', `${meta.title} as name`))
      names.set(`${kind}:${r.id}`, { uuid: r.uuid as string, name: (r.name as string) || '' });
  }
  const userIds = byKind('user');
  if (userIds.length)
    for (const u of await conn('users')
      .whereIn('id', userIds)
      .select('id', 'uuid', 'first_name', 'last_name', 'email'))
      names.set(`user:${u.id}`, {
        uuid: u.uuid as string,
        name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || (u.email as string),
      });
  for (const r of rows) {
    const n = names.get(`${r.kind}:${r.record_id}`);
    if (!n) continue;
    const list = out.get(r.activity_id) ?? [];
    list.push({ kind: r.kind, uuid: n.uuid, name: n.name, role: r.role });
    out.set(r.activity_id, list);
  }
  return out;
}

/**
 * Known people behind email addresses: contacts, open leads and colleagues. Used when logging
 * mail, so a message to two customers shows on both.
 */
export async function participantsFromAddresses(
  conn: Db,
  addresses: { address: string; role: ParticipantRole }[],
  ignore: string[] = [],
): Promise<ParticipantRow[]> {
  const skip = new Set(ignore.map((a) => a.toLowerCase()));
  const wanted = addresses
    .map((a) => ({ ...a, address: a.address.trim().toLowerCase() }))
    .filter((a) => a.address && !skip.has(a.address));
  if (!wanted.length) return [];
  const emails = [...new Set(wanted.map((a) => a.address))];
  const roleOf = new Map<string, ParticipantRole>();
  for (const a of wanted) if (!roleOf.has(a.address)) roleOf.set(a.address, a.role);
  const out: ParticipantRow[] = [];
  const contacts = await conn('contacts')
    .whereIn('email_norm', emails)
    .whereNull('deleted_at')
    .select('id', 'email_norm');
  for (const c of contacts) out.push({ kind: 'contact', record_id: c.id, role: roleOf.get(c.email_norm)! });
  const matched = new Set(contacts.map((c) => c.email_norm as string));
  const leads = await conn('leads')
    .whereIn(
      'email_norm',
      emails.filter((e) => !matched.has(e)),
    )
    .whereNull('deleted_at')
    .whereNull('converted_contact_id')
    .select('id', 'email_norm');
  for (const l of leads) out.push({ kind: 'lead', record_id: l.id, role: roleOf.get(l.email_norm)! });
  const users = await conn('users').whereIn('email', emails).whereNull('deleted_at').select('id', 'email');
  for (const u of users)
    out.push({ kind: 'user', record_id: u.id, role: roleOf.get((u.email as string).toLowerCase())! });
  return out;
}

/**
 * Activities on a record: related to it, or with it as a participant. `qb` is an activities query.
 * Mutates the builder (never returned from async code).
 */
export function whereOnRecord(qb: Knex.QueryBuilder, type: RelatedType, id: number, table = 'activities') {
  qb.where((w) =>
    w.where({ [`${table}.related_type`]: type, [`${table}.related_id`]: id }).orWhereExists((e) =>
      e
        .select(db.raw('1'))
        .from('activity_participants as ap')
        .whereRaw('ap.activity_id = ??', [`${table}.id`])
        .where({ 'ap.kind': type, 'ap.record_id': id }),
    ),
  );
}
