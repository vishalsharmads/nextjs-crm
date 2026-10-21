import { bulkSchema, filterSchema, type BulkInput } from '@app/shared';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import type { AuthUser, RequestContext } from '../../http/context';
import { assertCan } from '../rbac/access';
import { audit } from '../audit/audit.service';
import { applyListCriteria, scopedQuery, updateRecord, type DbRow } from '../records/service';
import { ensureTags } from '../records/hydrate';
import type { ResourceDef } from '../records/types';

const MAX = 5000;

/** Resolve the target rows: explicit uuids or "everything matching this list", always within scope. */
async function targets(def: ResourceDef, user: AuthUser, input: BulkInput): Promise<DbRow[]> {
  const { qb } = await scopedQuery(def, user, db, input.action === 'restore' ? 'only' : undefined);
  if (input.all) {
    const filter =
      input.filter === undefined || input.filter === null ? undefined : filterSchema.parse(input.filter);
    await applyListCriteria(qb, def, user, { filter, q: input.q, view: input.view });
  } else {
    if (!input.uuids?.length) throw new AppError('VALIDATION_FAILED', 'Select at least one record');
    qb.whereIn(`${def.table}.uuid`, input.uuids);
  }
  const rows = (await qb.limit(MAX + 1).select(`${def.table}.*`)) as DbRow[];
  if (rows.length > MAX)
    throw new AppError(
      'VALIDATION_FAILED',
      `Bulk actions are limited to ${MAX} records at a time. Narrow the filter.`,
    );
  return rows;
}

export async function runBulk(def: ResourceDef, ctx: RequestContext, user: AuthUser, raw: unknown) {
  const input = bulkSchema.parse(raw);
  const p = (a: string) => `${def.resource}.${a}`;
  assertCan(user, p('bulk'));
  const rows = await targets(def, user, input);
  const ids = rows.map((r) => r.id);
  let affected = 0;
  const failures: { uuid: string; message: string }[] = [];

  switch (input.action) {
    case 'delete':
    case 'restore': {
      assertCan(user, p('delete'));
      await db.transaction(async (trx) => {
        affected = await trx(def.table)
          .whereIn('id', ids)
          .update({ deleted_at: input.action === 'delete' ? new Date() : null, updated_by: user.id });
        for (const r of rows)
          await audit(trx, ctx, {
            action: `${def.entity}.${input.action === 'delete' ? 'deleted' : 'restored'}`,
            entity: def.entity,
            entityId: r.id,
            entityUuid: r.uuid,
            diff: { bulk: true },
          });
      });
      break;
    }
    case 'add_tags':
    case 'remove_tags': {
      assertCan(user, p('update'));
      if (!input.tags?.length) throw new AppError('VALIDATION_FAILED', 'Choose tags');
      await db.transaction(async (trx) => {
        const tagIds =
          input.action === 'add_tags'
            ? await ensureTags(input.tags!, user, trx)
            : ((await trx('tags').whereIn('name', input.tags!).pluck('id')) as number[]);
        for (const r of rows) {
          if (input.action === 'add_tags') {
            for (const tag_id of tagIds)
              await trx('taggables')
                .insert({ tag_id, taggable_type: def.entity, taggable_id: r.id })
                .onConflict(['tag_id', 'taggable_type', 'taggable_id'])
                .ignore();
          } else {
            await trx('taggables')
              .where({ taggable_type: def.entity, taggable_id: r.id })
              .whereIn('tag_id', tagIds)
              .delete();
          }
          await audit(trx, ctx, {
            action: `${def.entity}.updated`,
            entity: def.entity,
            entityId: r.id,
            entityUuid: r.uuid,
            diff: { [input.action]: input.tags },
          });
        }
        affected = rows.length;
      });
      break;
    }
    case 'assign':
    case 'update_field':
    case 'move_stage': {
      // Field-level and per-record rules (scope, visibility, validation) are enforced by the normal update path.
      let patch: Record<string, unknown>;
      if (input.action === 'assign') {
        assertCan(user, p('assign'));
        patch = { ownerUuid: input.ownerUuid ?? null };
        if (def.entity === 'activity') patch = { assigneeUuid: input.ownerUuid ?? null };
      } else if (input.action === 'move_stage') {
        if (def.entity !== 'deal' || !input.stageUuid)
          throw new AppError('VALIDATION_FAILED', 'Choose a stage');
        patch = { stageUuid: input.stageUuid };
      } else {
        if (!input.field) throw new AppError('VALIDATION_FAILED', 'Choose a field');
        patch = input.field.startsWith('cf.')
          ? { custom: { [input.field.slice(3)]: input.value ?? null } }
          : { [input.field]: input.value };
      }
      for (const r of rows) {
        try {
          await updateRecord(def, ctx, user, r.uuid, patch);
          affected++;
        } catch (err) {
          failures.push({ uuid: r.uuid, message: err instanceof Error ? err.message : 'Failed' });
        }
      }
      break;
    }
  }
  return { affected, failed: failures.length, failures: failures.slice(0, 50) };
}
