import { dealInputSchema, dealPatchSchema, type DealDto } from '@app/shared';
import type { Db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import type { ResourceDef } from '../records/types';
import { serializeCustom } from '../records/custom';
import {
  compact,
  customContext,
  dateField,
  numberField,
  ownerField,
  relationField,
  textField,
  timestampsFields,
} from '../records/common';
import { idFromUuid, iso, setTags, tagsFilter, tagsFor, userIdFromRef, userRefs } from '../records/hydrate';
import { getGroup } from '../settings/settings.service';

type Row = Record<string, unknown> & { id: number };

export async function nextReference(conn: Db, key = 'deal'): Promise<string> {
  const seq = await conn('sequences').where({ key }).forUpdate().first();
  if (!seq) return '';
  await conn('sequences')
    .where({ key })
    .update({ next_value: Number(seq.next_value) + 1 });
  const { numberPrefix } = await getGroup('deals', conn);
  return `${numberPrefix || seq.prefix || ''}${String(seq.next_value).padStart(seq.padding, '0')}`;
}

/** Resolve pipeline + stage for a write; stage must belong to the pipeline. */
export async function resolveStage(conn: Db, pipelineUuid?: string, stageUuid?: string, existing?: Row) {
  let pipelineId = existing?.pipeline_id as number | undefined;
  if (pipelineUuid) {
    const p = await conn('pipelines').where({ uuid: pipelineUuid, entity: 'deal', active: true }).first('id');
    if (!p)
      throw new AppError('VALIDATION_FAILED', 'Unknown pipeline', [
        { path: 'pipelineUuid', message: 'Unknown pipeline' },
      ]);
    pipelineId = p.id;
  }
  if (!pipelineId) {
    const p =
      (await conn('pipelines').where({ entity: 'deal', active: true, is_default: true }).first('id')) ??
      (await conn('pipelines').where({ entity: 'deal', active: true }).orderBy('sort_order').first('id'));
    if (!p) throw new AppError('VALIDATION_FAILED', 'Create a pipeline first');
    pipelineId = p.id;
  }
  let stage;
  if (stageUuid) {
    stage = await conn('pipeline_stages')
      .where({ uuid: stageUuid, pipeline_id: pipelineId, active: true })
      .first();
    if (!stage) throw new AppError('STAGE_INVALID', 'That stage is not part of this pipeline');
  } else if (existing && existing.pipeline_id === pipelineId) {
    stage = await conn('pipeline_stages').where({ id: existing.stage_id }).first();
  } else {
    stage = await conn('pipeline_stages')
      .where({ pipeline_id: pipelineId, active: true, is_won: false, is_lost: false })
      .orderBy('sort_order')
      .first();
    if (!stage) throw new AppError('STAGE_INVALID', 'This pipeline has no open stages');
  }
  return { pipelineId: pipelineId!, stage };
}

export function statusForStage(stage: { is_won: number | boolean; is_lost: number | boolean }) {
  return stage.is_won ? 'won' : stage.is_lost ? 'lost' : 'open';
}

export const dealsDef: ResourceDef<Row, DealDto> = {
  entity: 'deal',
  table: 'deals',
  resource: 'core.deals',
  ownerColumns: ['deals.owner_id'],
  fulltext: ['deals.title'],
  likeColumns: ['deals.title', 'deals.reference'],
  notifyColumn: 'owner_id',
  defaultSort: '-created_at',
  createSchema: dealInputSchema,
  patchSchema: dealPatchSchema,
  fields: {
    title: textField('deals.title'),
    reference: textField('deals.reference'),
    value: numberField('deals.value'),
    currency: { kind: 'select', column: 'deals.currency', sortable: true, filterable: true },
    status: { kind: 'select', column: 'deals.status', sortable: true, filterable: true },
    expected_close: dateField('deals.expected_close', 'date'),
    won_at: dateField('deals.won_at'),
    lost_at: dateField('deals.lost_at'),
    lost_reason: { kind: 'select', column: 'deals.lost_reason', sortable: true, filterable: true },
    stage_entered_at: dateField('deals.stage_entered_at'),
    stage: relationField('deals', 'stage_id', 'pipeline_stages', 'sort_order'),
    pipeline: relationField('deals', 'pipeline_id', 'pipelines', 'name'),
    contact: relationField('deals', 'contact_id', 'contacts', 'full_name'),
    organization: relationField('deals', 'organization_id', 'organizations', 'name'),
    owner: ownerField('deals'),
    tags: { kind: 'relation', filter: tagsFilter('deal', 'deals') },
    ...timestampsFields('deals'),
  },
  async toRow(input, { user, conn, existing }) {
    const row: Record<string, unknown> = compact({
      title: input.title as string | undefined,
      value: input.value as number | undefined,
      currency: input.currency as string | undefined,
      expected_close: input.expectedClose as string | null | undefined,
      lost_reason: input.lostReason as string | null | undefined,
      owner_id: await userIdFromRef(input.ownerUuid as string | null | undefined, user, conn),
      contact_id: await idFromUuid(
        'contacts',
        input.contactUuid as string | null | undefined,
        'contactUuid',
        conn,
      ),
      organization_id: await idFromUuid(
        'organizations',
        input.organizationUuid as string | null | undefined,
        'organizationUuid',
        conn,
      ),
    });
    if (!existing || input.pipelineUuid || input.stageUuid) {
      const { pipelineId, stage } = await resolveStage(
        conn,
        input.pipelineUuid as string | undefined,
        input.stageUuid as string | undefined,
        existing as Row | undefined,
      );
      row.pipeline_id = pipelineId;
      if (!existing || existing.stage_id !== stage.id) {
        const status = statusForStage(stage);
        row.stage_id = stage.id;
        row.status = status;
        row.stage_entered_at = new Date();
        row.won_at = status === 'won' ? new Date() : null;
        row.lost_at = status === 'lost' ? new Date() : null;
        if (status !== 'lost' && input.lostReason === undefined) row.lost_reason = null;
        const max = await conn('deals')
          .where({ stage_id: stage.id })
          .whereNull('deleted_at')
          .max({ m: 'position' })
          .first();
        row.position = Number((max as { m: number | null } | undefined)?.m ?? 0) + 1000;
      }
    }
    if (!existing && !row.currency) row.currency = (await getGroup('general', conn)).currency;
    return row;
  },
  async beforeCreate(row, { conn }) {
    row.reference = (await nextReference(conn)) || null;
  },
  async afterWrite(id, input, { user, conn, existing }) {
    if (input.tags) await setTags('deal', id, input.tags as string[], user, conn);
    const now = await conn('deals').where({ id }).first('stage_id');
    if (!existing || existing.stage_id !== now.stage_id) {
      await conn('deal_stage_history').insert({
        deal_id: id,
        from_stage_id: existing?.stage_id ?? null,
        to_stage_id: now.stage_id,
        changed_by: user.id,
      });
    }
  },
  async toDtos(rows, { user, conn }) {
    const ids = rows.map((r) => r.id);
    const [owners, tags, cf] = await Promise.all([
      userRefs(
        rows.map((r) => r.owner_id as number | null),
        conn,
      ),
      tagsFor('deal', ids, conn),
      customContext('deal', user),
    ]);
    const lookup = async (table: string, col: string, key: string) => {
      const relIds = [...new Set(rows.map((r) => r[key]).filter(Boolean))] as number[];
      const rel = relIds.length
        ? await conn(table).whereIn('id', relIds).select('id', 'uuid', `${col} as label`)
        : [];
      return new Map(rel.map((x) => [x.id as number, { uuid: x.uuid as string, name: x.label as string }]));
    };
    const [contacts, orgs, pipelines] = await Promise.all([
      lookup('contacts', 'full_name', 'contact_id'),
      lookup('organizations', 'name', 'organization_id'),
      lookup('pipelines', 'name', 'pipeline_id'),
    ]);
    const stageIds = [...new Set(rows.map((r) => r.stage_id as number))];
    const stages = new Map(
      (stageIds.length ? await conn('pipeline_stages').whereIn('id', stageIds) : []).map((s) => [
        s.id as number,
        s,
      ]),
    );
    return rows.map((r) => {
      const s = stages.get(r.stage_id as number);
      const entered = new Date(r.stage_entered_at as string);
      const rotting =
        r.status === 'open' &&
        !!s?.rotting_days &&
        Date.now() - entered.getTime() > s.rotting_days * 86_400_000;
      return {
        uuid: r.uuid as string,
        reference: (r.reference as string | null) ?? null,
        title: r.title as string,
        contact: contacts.get(r.contact_id as number) ?? null,
        organization: orgs.get(r.organization_id as number) ?? null,
        pipeline: pipelines.get(r.pipeline_id as number) ?? { uuid: '', name: '' },
        stage: {
          uuid: s?.uuid,
          key: s?.key,
          name: s?.name,
          isWon: !!s?.is_won,
          isLost: !!s?.is_lost,
          probability: Number(s?.probability ?? 0),
          color: s?.color ?? null,
        },
        value: Number(r.value),
        currency: r.currency as string,
        expectedClose: (r.expected_close as string | null) ?? null,
        status: r.status as DealDto['status'],
        wonAt: iso(r.won_at),
        lostAt: iso(r.lost_at),
        lostReason: (r.lost_reason as string | null) ?? null,
        stageEnteredAt: entered.toISOString(),
        rotting,
        position: Number(r.position),
        owner: owners.get(r.owner_id as number) ?? null,
        tags: tags.get(r.id) ?? [],
        custom: serializeCustom(r.custom, cf.defs, cf.levels),
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
        deletedAt: iso(r.deleted_at),
      };
    });
  },
};
