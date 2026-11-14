import { recordShareSchema, type RecordShareDto, type RecordSharesResult } from '@app/shared';
import type { AuthUser, RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { can, scopeAllows } from '../rbac/access';
import { getRow } from '../records/service';
import { iso, userRefs } from '../records/hydrate';
import { recordBasePath } from '../records/paths';
import type { ResourceDef } from '../records/types';
import { notify } from '../notifications/notifications.service';
import { titleColumn } from '../comments/comments';

type Row = Record<string, unknown> & { id: number };

/**
 * Who may share a record: admins, its owner, and people with `<resource>.share` whose role scope
 * (not a share) covers it. Sharing onwards through a share is not possible.
 */
async function canManage(def: ResourceDef, user: AuthUser, record: Row): Promise<boolean> {
  if (user.isAdmin) return true;
  if (record.owner_id === user.id) return true;
  if (!can(user, `${def.resource}.share`)) return false;
  return scopeAllows(
    user,
    def.resource,
    def.ownerColumns.map((c) => (record[c.split('.').pop()!] as number | null) ?? null),
  );
}

async function toDtos(rows: Row[], conn: Db = db): Promise<RecordShareDto[]> {
  const refs = await userRefs(
    rows.flatMap((r) => [r.user_id as number, r.shared_by as number]),
    conn,
  );
  const teamIds = rows.map((r) => r.team_id).filter((id): id is number => typeof id === 'number');
  const teams = new Map(
    (teamIds.length ? await conn('teams').whereIn('id', teamIds).select('id', 'uuid', 'name') : []).map(
      (t) => [t.id as number, { uuid: t.uuid as string, name: t.name as string }],
    ),
  );
  return rows.map((r) => ({
    uuid: r.uuid as string,
    user: r.user_id ? (refs.get(r.user_id as number) ?? null) : null,
    team: r.team_id ? (teams.get(r.team_id as number) ?? null) : null,
    level: r.level as 'view' | 'edit',
    sharedBy: r.shared_by ? (refs.get(r.shared_by as number) ?? null) : null,
    createdAt: iso(r.created_at)!,
  }));
}

export async function listShares(
  def: ResourceDef,
  user: AuthUser,
  recordUuid: string,
): Promise<RecordSharesResult> {
  const record = (await getRow(def, user, recordUuid)) as Row;
  const rows = (await db('record_shares')
    .where({ resource: def.resource, record_id: record.id })
    .orderBy('id')) as Row[];
  return { data: await toDtos(rows), canManage: await canManage(def, user, record) };
}

export async function shareRecord(
  def: ResourceDef,
  ctx: RequestContext,
  user: AuthUser,
  recordUuid: string,
  raw: unknown,
): Promise<RecordShareDto> {
  const input = recordShareSchema.parse(raw);
  const record = (await getRow(def, user, recordUuid, db, { shares: 'none' }).catch(async () => {
    // Someone who only sees it through a share cannot share it onwards.
    await getRow(def, user, recordUuid);
    throw new AppError('FORBIDDEN', 'Only the owner can share this record');
  })) as Row;
  if (!(await canManage(def, user, record)))
    throw new AppError('FORBIDDEN', 'Only the owner can share this record');

  let target: { user_id: number | null; team_id: number | null };
  if (input.userUuid) {
    const person = await db('users')
      .where({ uuid: input.userUuid, status: 'active' })
      .whereNull('deleted_at')
      .first('id');
    if (!person) throw notFound('Person');
    if (person.id === record.owner_id)
      throw new AppError('VALIDATION_FAILED', 'They own this record already');
    target = { user_id: person.id as number, team_id: null };
  } else {
    const team = await db('teams').where({ uuid: input.teamUuid }).first('id');
    if (!team) throw notFound('Team');
    target = { user_id: null, team_id: team.id as number };
  }

  const row = await db.transaction(async (trx) => {
    // Lock the record so two shares at once cannot both insert.
    await trx(def.table).where({ id: record.id }).forUpdate().first('id');
    const existing = await trx('record_shares')
      .where({ resource: def.resource, record_id: record.id, ...target })
      .first();
    let id: number;
    if (existing) {
      id = existing.id as number;
      await trx('record_shares').where({ id }).update({ level: input.level, shared_by: user.id });
    } else {
      [id] = (await trx('record_shares').insert({
        uuid: newUuid(),
        resource: def.resource,
        record_id: record.id,
        ...target,
        level: input.level,
        shared_by: user.id,
      })) as [number];
    }
    await audit(trx, ctx, {
      action: `${def.entity}.shared`,
      entity: def.entity,
      entityId: record.id,
      entityUuid: recordUuid,
      diff: { share: { user: input.userUuid ?? null, team: input.teamUuid ?? null, level: input.level } },
    });
    return (await trx('record_shares').where({ id }).first()) as Row;
  });

  if (target.user_id) {
    const col = titleColumn(def);
    const title = (col && (record[col] as string | null)) || 'a record';
    await notify(
      target.user_id,
      {
        type: 'record.shared',
        title: `${user.firstName} shared “${title}” with you${input.level === 'edit' ? ' (can edit)' : ''}`,
        link: `${recordBasePath(def)}/${recordUuid}`,
        email: true,
      },
      { actorId: user.id },
    );
  }
  return (await toDtos([row]))[0]!;
}

export async function unshareRecord(
  def: ResourceDef,
  ctx: RequestContext,
  user: AuthUser,
  recordUuid: string,
  shareUuid: string,
) {
  const record = (await getRow(def, user, recordUuid)) as Row;
  const share = await db('record_shares')
    .where({ uuid: shareUuid, resource: def.resource, record_id: record.id })
    .first();
  if (!share) throw notFound('Share');
  // People may always remove their own access; otherwise only those who manage sharing.
  if (share.user_id !== user.id && !(await canManage(def, user, record)))
    throw new AppError('FORBIDDEN', 'Only the owner can change who this record is shared with');
  await db.transaction(async (trx) => {
    await trx('record_shares').where({ id: share.id }).delete();
    await audit(trx, ctx, {
      action: `${def.entity}.unshared`,
      entity: def.entity,
      entityId: record.id,
      entityUuid: recordUuid,
      diff: { share: shareUuid },
    });
  });
}

/**
 * Merges do not carry shares across: a share opened one record, and the kept record holds more
 * than that. The merged-away records' shares are removed.
 */
export async function dropSharesOnMerge(conn: Db, resource: string, secondaryIds: number[]) {
  await conn('record_shares').where({ resource }).whereIn('record_id', secondaryIds).delete();
}
