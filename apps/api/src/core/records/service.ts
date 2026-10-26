import type { Knex } from 'knex';
import type { ListQuery, ListResponse } from '@app/shared';
import { db, type Db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import type { AuthUser, RequestContext } from '../../http/context';
import { audit, diffRecords } from '../audit/audit.service';
import { logAccess } from '../audit/access-log';
import { applyScope, assertCan, scopeAllows } from '../rbac/access';
import { fieldAccessMap, getDefinitions } from '../custom-fields/definitions';
import { applySearch, applySort, compileFilter, type FilterContext } from './filters';
import { prepareCustom, redactDiff } from './custom';
import { notify } from '../notifications/notifications.service';
import { emit, type EventType } from '../events/events';
import { ENTITY_ROUTE } from '@app/shared';
import type { ResourceDef } from './types';

export async function filterContext(def: ResourceDef, user: AuthUser): Promise<FilterContext> {
  const customDefs = await getDefinitions(def.entity);
  return { def, user, customDefs, fieldLevels: fieldAccessMap(customDefs, user) };
}

/** A record row: every record table has a numeric id and a public uuid. */
export type DbRow = Record<string, unknown> & { id: number; uuid: string };

const perm = (def: ResourceDef, action: string) => `${def.resource}.${action}`;

/**
 * Base query: not deleted (unless asked), restricted to the user's record scope.
 * Wrapped in an object: an async function must never return a Knex builder (await would run it).
 */
export async function scopedQuery(
  def: ResourceDef,
  user: AuthUser,
  conn: Db = db,
  trashed?: 'only' | 'with',
) {
  const qb = conn(def.table);
  if (trashed === 'only') qb.whereNotNull(`${def.table}.deleted_at`);
  else if (!trashed) qb.whereNull(`${def.table}.deleted_at`);
  await applyScope(qb, user, def.resource, def.ownerColumns, conn);
  return { qb };
}

/** Apply view-defined filter + request filter + search to a query. */
export async function applyListCriteria(
  qb: Knex.QueryBuilder,
  def: ResourceDef,
  user: AuthUser,
  query: Pick<ListQuery, 'filter' | 'q' | 'view'>,
) {
  const fc = await filterContext(def, user);
  if (query.view) {
    const view = await db('saved_views')
      .where({ uuid: query.view, entity: def.entity })
      .where((w) => w.where({ owner_id: user.id }).orWhere({ is_shared: true }))
      .first();
    if (!view) throw notFound('View');
    if (view.filters) compileFilter(qb, view.filters, fc);
  }
  if (query.filter) compileFilter(qb, query.filter, fc);
  applySearch(qb, query.q, def);
  return fc;
}

export async function listRecords<Dto>(
  def: ResourceDef<Record<string, unknown>, Dto>,
  user: AuthUser,
  query: ListQuery,
): Promise<ListResponse<Dto>> {
  assertCan(user, perm(def, 'view'));
  if (query.trashed) assertCan(user, perm(def, 'delete'));
  const { qb } = await scopedQuery(def, user, db, query.trashed);
  const fc = await applyListCriteria(qb, def, user, query);
  const total = Number(
    ((await qb.clone().clearSelect().clearOrder().count({ c: '*' }).first()) as { c: number }).c,
  );
  let sort = query.sort;
  if (!sort && query.view) {
    const view = await db('saved_views').where({ uuid: query.view }).first('sort');
    const s = view?.sort as { field: string; dir: 'asc' | 'desc' }[] | null;
    if (s?.length) sort = s.map((x) => `${x.dir === 'desc' ? '-' : ''}${x.field}`).join(',');
  }
  applySort(qb, sort, fc);
  const rows = await qb
    .select(`${def.table}.*`)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return {
    data: await def.toDtos(rows, { user, conn: db }),
    meta: { page: query.page, pageSize: query.pageSize, total },
  };
}

/** Load one record the user may see (404 when out of scope, so ids cannot be probed). */
export async function getRow(
  def: ResourceDef,
  user: AuthUser,
  uuid: string,
  conn: Db = db,
  opts: { withDeleted?: boolean; forUpdate?: boolean } = {},
) {
  const { qb } = await scopedQuery(def, user, conn, opts.withDeleted ? 'with' : undefined);
  qb.where(`${def.table}.uuid`, uuid);
  if (opts.forUpdate) qb.forUpdate();
  const row = await qb.first(`${def.table}.*`);
  if (!row) throw notFound();
  return row as DbRow;
}

export async function getRecord<Dto>(
  def: ResourceDef<Record<string, unknown>, Dto>,
  user: AuthUser,
  uuid: string,
  ctx?: RequestContext,
): Promise<Dto> {
  assertCan(user, perm(def, 'view'));
  const row = await getRow(def, user, uuid);
  if (ctx)
    await logAccess(ctx, {
      action: 'view',
      entity: def.entity,
      entityId: row.id as number,
      entityUuid: uuid,
    });
  const [dto] = await def.toDtos([row], { user, conn: db });
  return dto!;
}

export async function createRecord<Dto>(
  def: ResourceDef<Record<string, unknown>, Dto>,
  ctx: RequestContext,
  user: AuthUser,
  input: Record<string, unknown>,
  conn?: Knex.Transaction,
): Promise<Dto> {
  assertCan(user, perm(def, 'create'));
  const core = def.createSchema.parse(input) as Record<string, unknown>;
  const fc = await filterContext(def, user);
  const custom = prepareCustom(
    fc.customDefs,
    fc.fieldLevels,
    input.custom as Record<string, unknown> | undefined,
    'create',
  );

  const run = async (trx: Knex.Transaction) => {
    const wctx = { user, conn: trx, ctx };
    const row = await def.toRow(core, wctx);
    if (!('owner_id' in row) && def.ownerColumns.includes(`${def.table}.owner_id`)) row.owner_id = user.id;
    // People with "own" scope can only create records they own (or are assigned).
    if (
      !(await scopeAllows(
        user,
        def.resource,
        def.ownerColumns.map((c) => (row[c.split('.')[1]!] as number | null) ?? null),
        trx,
      ))
    ) {
      throw new AppError('FORBIDDEN', 'You can only create records you own');
    }
    const values = {
      ...row,
      uuid: newUuid(),
      custom: JSON.stringify(custom),
      created_by: user.id,
      updated_by: user.id,
    };
    await def.beforeCreate?.(values, wctx);
    const [id] = await trx(def.table).insert(values);
    await def.afterWrite?.(id!, core, wctx, 'create');
    await audit(trx, ctx, {
      action: `${def.entity}.created`,
      entity: def.entity,
      entityId: id,
      entityUuid: values.uuid as string,
      diff: redactDiff({ ...row, custom }, fc.fieldLevels),
    });
    return trx(def.table).where({ id }).first();
  };
  const created = conn ? await run(conn) : await db.transaction(run);
  await notifyAssignment(def, user, created);
  const [dto] = await def.toDtos([created], { user, conn: db });
  if (!conn) await emitRecordEvent(def, 'created', dto as Record<string, unknown>, user);
  return dto!;
}

export async function updateRecord<Dto>(
  def: ResourceDef<Record<string, unknown>, Dto>,
  ctx: RequestContext,
  user: AuthUser,
  uuid: string,
  input: Record<string, unknown>,
): Promise<Dto> {
  assertCan(user, perm(def, 'update'));
  const core = def.patchSchema.parse(input) as Record<string, unknown>;
  const fc = await filterContext(def, user);
  const updated = await db.transaction(async (trx) => {
    const existing = await getRow(def, user, uuid, trx, { forUpdate: true });
    const wctx = { user, conn: trx, ctx, existing };
    const row = await def.toRow(core, wctx);
    if ('owner_id' in row && row.owner_id !== existing.owner_id) {
      assertCan(user, perm(def, 'assign'));
      if (!(await scopeAllows(user, def.resource, [row.owner_id as number | null], trx))) {
        throw new AppError('FORBIDDEN', 'You cannot assign records outside your scope');
      }
    }
    const custom =
      input.custom !== undefined
        ? prepareCustom(
            fc.customDefs,
            fc.fieldLevels,
            input.custom as Record<string, unknown>,
            'patch',
            (existing.custom as Record<string, unknown>) ?? {},
          )
        : undefined;
    const values: Record<string, unknown> = { ...row, updated_by: user.id };
    if (custom) values.custom = JSON.stringify(custom);
    await trx(def.table).where({ id: existing.id }).update(values);
    await def.afterWrite?.(existing.id as number, core, wctx, 'update');
    const after = await trx(def.table).where({ id: existing.id }).first();
    const diff = diffRecords(existing, after);
    if (Object.keys(diff).length) {
      await audit(trx, ctx, {
        action: `${def.entity}.updated`,
        entity: def.entity,
        entityId: existing.id as number,
        entityUuid: uuid,
        diff: redactDiff(diff, fc.fieldLevels),
      });
    }
    return { after, existing };
  });
  await notifyAssignment(def, user, updated.after, updated.existing);
  const [dto] = await def.toDtos([updated.after], { user, conn: db });
  const changes = diffRecords(updated.existing, updated.after);
  if (Object.keys(changes).length) {
    await emitRecordEvent(def, 'updated', dto as Record<string, unknown>, user, changes);
    if (def.entity === 'deal' && changes.stage_id)
      await emitDealStage(dto as Record<string, unknown>, user, changes);
    if (def.entity === 'activity' && changes.completed_at && updated.after.completed_at) {
      await emitRecordEvent(def, 'completed', dto as Record<string, unknown>, user, changes);
    }
  }
  return dto!;
}

export async function deleteRecord(def: ResourceDef, ctx: RequestContext, user: AuthUser, uuid: string) {
  assertCan(user, perm(def, 'delete'));
  await db.transaction(async (trx) => {
    const row = await getRow(def, user, uuid, trx, { forUpdate: true });
    await trx(def.table).where({ id: row.id }).update({ deleted_at: new Date(), updated_by: user.id });
    await audit(trx, ctx, {
      action: `${def.entity}.deleted`,
      entity: def.entity,
      entityId: row.id as number,
      entityUuid: uuid,
    });
  });
  await emitRecordEvent(def, 'deleted', { uuid }, user);
}

export async function restoreRecord<Dto>(
  def: ResourceDef<Record<string, unknown>, Dto>,
  ctx: RequestContext,
  user: AuthUser,
  uuid: string,
): Promise<Dto> {
  assertCan(user, perm(def, 'delete'));
  const row = await db.transaction(async (trx) => {
    const r = await getRow(def, user, uuid, trx, { withDeleted: true, forUpdate: true });
    if (r.merged_into_id) throw new AppError('CONFLICT', 'Merged records cannot be restored');
    await trx(def.table).where({ id: r.id }).update({ deleted_at: null, updated_by: user.id });
    await audit(trx, ctx, {
      action: `${def.entity}.restored`,
      entity: def.entity,
      entityId: r.id as number,
      entityUuid: uuid,
    });
    return trx(def.table).where({ id: r.id }).first();
  });
  const [dto] = await def.toDtos([row], { user, conn: db });
  return dto!;
}

/** Tell the new owner/assignee about a record handed to them. */
export async function notifyAssignment(
  def: ResourceDef,
  user: AuthUser,
  row: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  const col = def.notifyColumn;
  if (!col) return;
  const to = row[col] as number | null | undefined;
  if (!to || to === user.id || (before && before[col] === to)) return;
  const title = (row.title ?? row.full_name ?? row.name ?? row.subject ?? '') as string;
  const who = `${user.firstName} ${user.lastName}`.trim() || user.email;
  await notify(
    to,
    {
      type: `${def.entity}.assigned`,
      title: `${who} assigned you ${title ? `“${title}”` : 'a record'}`,
      link: def.entity === 'activity' ? '/tasks' : `/${ENTITY_ROUTE[def.entity]}/${row.uuid as string}`,
      data: { entity: def.entity, uuid: row.uuid },
      email: true,
    },
    { actorId: user.id },
  );
}

export async function emitRecordEvent(
  def: Pick<ResourceDef, 'entity'>,
  action: 'created' | 'updated' | 'deleted' | 'completed' | 'converted',
  record: Record<string, unknown>,
  user: AuthUser,
  changes?: Record<string, { from: unknown; to: unknown }>,
) {
  await emit({
    type: `${def.entity}.${action}` as EventType,
    entity: def.entity,
    uuid: record.uuid as string,
    record,
    changes,
    actorId: user.id,
  });
}

/** Stage moves also emit won/lost so automations can react to outcomes. */
export async function emitDealStage(
  record: Record<string, unknown>,
  user: AuthUser,
  changes: Record<string, { from: unknown; to: unknown }>,
) {
  await emit({
    type: 'deal.stage_changed',
    entity: 'deal',
    uuid: record.uuid as string,
    record,
    changes,
    actorId: user.id,
  });
  const status = record.status as string;
  if (status === 'won' || status === 'lost')
    await emit({
      type: `deal.${status}`,
      entity: 'deal',
      uuid: record.uuid as string,
      record,
      changes,
      actorId: user.id,
    });
}
