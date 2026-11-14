import { guardStandardFields } from '../custom-fields/standard-visibility';
import { leadCreateSchema, leadPatchSchema, type LeadDto } from '@app/shared';
import type { ResourceDef } from '../records/types';
import { serializeCustom } from '../records/custom';
import {
  compact,
  customContext,
  dateField,
  relationField,
  ownerField,
  phoneE164,
  selectField,
  textField,
  timestampsFields,
} from '../records/common';
import { getGroup } from '../settings/settings.service';
import {
  endOfStage,
  isRotting,
  recordStageHistory,
  resolveStage,
  type StageRow,
} from '../pipelines/stage-engine';
import { iso, setTags, tagsFilter, tagsFor, userIdFromRef, userRefs } from '../records/hydrate';

type Row = Record<string, unknown> & { id: number };

export const leadsDef: ResourceDef<Row, LeadDto> = {
  entity: 'lead',
  route: 'leads',
  table: 'leads',
  resource: 'core.leads',
  ownerColumns: ['leads.owner_id'],
  fulltext: ['leads.full_name', 'leads.email', 'leads.company_name'],
  likeColumns: ['leads.full_name', 'leads.email', 'leads.company_name'],
  notifyColumn: 'owner_id',
  defaultSort: '-created_at',
  createSchema: leadCreateSchema,
  patchSchema: leadPatchSchema,
  fields: {
    full_name: textField('leads.full_name'),
    email: textField('leads.email'),
    phone: textField('leads.phone_e164'),
    company_name: textField('leads.company_name'),
    job_title: textField('leads.job_title'),
    source: selectField('leads.source'),
    status: selectField('leads.status'),
    stage: relationField('leads', 'stage_id', 'pipeline_stages', 'sort_order'),
    pipeline: relationField('leads', 'pipeline_id', 'pipelines', 'name'),
    stage_entered_at: dateField('leads.stage_entered_at'),
    owner: ownerField('leads'),
    tags: { kind: 'relation', filter: tagsFilter('lead', 'leads') },
    ...timestampsFields('leads'),
  },
  async toRow(input, { user, conn, existing }) {
    const row: Record<string, unknown> = compact({
      first_name: input.firstName as string | undefined,
      last_name: input.lastName as string | undefined,
      email: input.email as string | null | undefined,
      phone: input.phone as string | null | undefined,
      phone_e164: phoneE164(input.phone as string | null | undefined),
      company_name: input.companyName as string | null | undefined,
      job_title: input.jobTitle as string | null | undefined,
      source: input.source as string | null | undefined,
      status: input.status as string | undefined,
      owner_id: await userIdFromRef(input.ownerUuid as string | null | undefined, user, conn),
    });
    // Stages only apply while the lead pipeline is on; new leads start on the default pipeline's first stage.
    const wantsStage = !existing || input.pipelineUuid || input.stageUuid;
    if (wantsStage && (await getGroup('features', conn)).leadPipeline) {
      const placed = await resolveStage(
        conn,
        'lead',
        input.pipelineUuid as string | undefined,
        input.stageUuid as string | undefined,
        existing,
        !input.pipelineUuid && !input.stageUuid,
      );
      if (placed) {
        row.pipeline_id = placed.pipelineId;
        if (!existing || existing.stage_id !== placed.stage.id) {
          row.stage_id = placed.stage.id;
          row.stage_entered_at = new Date();
          row.position = await endOfStage(conn, 'lead', placed.stage.id);
        }
      }
    }
    return row;
  },
  async afterWrite(id, input, { user, conn, existing }) {
    if (input.tags) await setTags('lead', id, input.tags as string[], user, conn);
    const now = await conn('leads').where({ id }).first('stage_id');
    if (now?.stage_id && (existing?.stage_id ?? null) !== now.stage_id) {
      await recordStageHistory(
        conn,
        'lead',
        [id],
        (existing?.stage_id as number | undefined) ?? null,
        now.stage_id,
        user.id,
      );
    }
  },
  async toDtos(rows, { user, conn }) {
    const ids = rows.map((r) => r.id);
    const [owners, tags, cf] = await Promise.all([
      userRefs(
        rows.map((r) => r.owner_id as number | null),
        conn,
      ),
      tagsFor('lead', ids, conn),
      customContext('lead', user),
    ]);
    const uuidOf = async (table: string, col: string) => {
      const relIds = rows.map((r) => r[col]).filter(Boolean) as number[];
      const rel = relIds.length ? await conn(table).whereIn('id', relIds).select('id', 'uuid') : [];
      return new Map(rel.map((x) => [x.id as number, x.uuid as string]));
    };
    const [contacts, orgs, deals] = await Promise.all([
      uuidOf('contacts', 'converted_contact_id'),
      uuidOf('organizations', 'converted_organization_id'),
      uuidOf('deals', 'converted_deal_id'),
    ]);
    const stageIds = [...new Set(rows.map((r) => r.stage_id).filter(Boolean))] as number[];
    const pipelineIds = [...new Set(rows.map((r) => r.pipeline_id).filter(Boolean))] as number[];
    const [stages, pipelines] = await Promise.all([
      stageIds.length ? conn('pipeline_stages').whereIn('id', stageIds) : [],
      pipelineIds.length ? conn('pipelines').whereIn('id', pipelineIds).select('id', 'uuid', 'name') : [],
    ]);
    const stageOf = new Map(stages.map((s) => [s.id as number, s as StageRow]));
    const pipelineOf = new Map(
      pipelines.map((p) => [p.id as number, { uuid: p.uuid as string, name: p.name as string }]),
    );
    return rows.map((r) => {
      const s = stageOf.get(r.stage_id as number);
      return {
        uuid: r.uuid as string,
        firstName: r.first_name as string,
        lastName: r.last_name as string,
        fullName: (r.full_name as string) || (r.company_name as string) || (r.email as string) || '',
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        companyName: (r.company_name as string | null) ?? null,
        jobTitle: (r.job_title as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        status: r.status as LeadDto['status'],
        processingRestricted: !!r.processing_restricted,
        marketingOptOut: !!r.marketing_opt_out,
        convertedAt: iso(r.converted_at),
        converted: r.converted_at
          ? {
              contactUuid: contacts.get(r.converted_contact_id as number) ?? null,
              organizationUuid: orgs.get(r.converted_organization_id as number) ?? null,
              dealUuid: deals.get(r.converted_deal_id as number) ?? null,
            }
          : null,
        owner: owners.get(r.owner_id as number) ?? null,
        tags: tags.get(r.id) ?? [],
        pipeline: pipelineOf.get(r.pipeline_id as number) ?? null,
        stage: s
          ? {
              uuid: s.uuid as string,
              key: s.key as string,
              name: s.name as string,
              color: (s.color as string | null) ?? null,
              isWon: !!s.is_won,
              isLost: !!s.is_lost,
            }
          : null,
        stageEnteredAt: iso(r.stage_entered_at),
        rotting: isRotting(s, r.stage_entered_at),
        position: r.position == null ? null : Number(r.position),
        custom: serializeCustom(r.custom, cf.defs, cf.levels),
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
        deletedAt: iso(r.deleted_at),
      };
    });
  },
};

// Standard fields hidden from the viewer never leave the API (phase 12d).
guardStandardFields(leadsDef);
