import { z } from 'zod';
import { dealMoveSchema, leadConvertSchema, type DealDto } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import { applyScope, assertCan } from '../rbac/access';
import { applyListCriteria, createRecord, emitDealStage, emitRecordEvent, getRow } from '../records/service';
import { recordRoutes } from '../records/routes';
import { filterParamSchema } from '@app/shared';
import { dealsDef, statusForStage } from './deals.def';
import { leadsDef } from '../leads/leads.def';
import { contactsDef } from '../contacts/contacts.def';
import { organizationsDef } from '../organizations/organizations.def';
import { getGroup } from '../settings/settings.service';

const BOARD_LIMIT_PER_STAGE = 200;

export const dealsRoutes = [
  defineRoutes('/deals', ['deals'])
    .add({
      method: 'get',
      path: '/board',
      permission: 'core.deals.view',
      summary: 'Deals grouped by stage for the Kanban board',
      query: z.object({
        pipeline: z.uuid().optional(),
        filter: filterParamSchema.optional(),
        q: z.string().max(200).optional(),
        view: z.uuid().optional(),
      }),
      handler: async ({ user, query }) => {
        const pipeline = query.pipeline
          ? await db('pipelines').where({ uuid: query.pipeline, entity: 'deal' }).first()
          : ((await db('pipelines').where({ entity: 'deal', is_default: true, active: true }).first()) ??
            (await db('pipelines').where({ entity: 'deal', active: true }).orderBy('sort_order').first()));
        if (!pipeline) throw notFound('Pipeline');
        const stages = await db('pipeline_stages')
          .where({ pipeline_id: pipeline.id, active: true })
          .orderBy('sort_order');
        const qb = db('deals').whereNull('deals.deleted_at').where('deals.pipeline_id', pipeline.id);
        await applyScope(qb, user, dealsDef.resource, dealsDef.ownerColumns);
        await applyListCriteria(qb, dealsDef, user, query);
        const totals = await qb
          .clone()
          .groupBy('deals.stage_id')
          .select('deals.stage_id')
          .count({ n: '*' })
          .sum({ v: 'deals.value' });
        const rows = await qb
          .clone()
          .select('deals.*')
          .orderBy('deals.position')
          .orderBy('deals.id')
          .limit(BOARD_LIMIT_PER_STAGE * Math.max(stages.length, 1));
        const dtos = await dealsDef.toDtos(rows, { user, conn: db });
        return {
          pipeline: { uuid: pipeline.uuid, name: pipeline.name },
          columns: stages.map((s) => {
            const t = (totals as { stage_id: number; n: number; v: number }[]).find(
              (x) => x.stage_id === s.id,
            );
            return {
              stage: {
                uuid: s.uuid,
                key: s.key,
                name: s.name,
                color: s.color,
                probability: s.probability,
                isWon: !!s.is_won,
                isLost: !!s.is_lost,
                rottingDays: s.rotting_days,
              },
              count: Number(t?.n ?? 0),
              total: Number(t?.v ?? 0),
              deals: dtos.filter((d) => d.stage.uuid === s.uuid).slice(0, BOARD_LIMIT_PER_STAGE),
            };
          }),
        };
      },
    })
    .add({
      method: 'patch',
      path: '/:uuid/stage',
      permission: 'core.deals.update',
      params: z.object({ uuid: z.uuid() }),
      body: dealMoveSchema,
      summary: 'Move a deal to a stage (and position within it)',
      handler: async ({ ctx, user, params, body }): Promise<DealDto> => {
        const updated = await db.transaction(async (trx) => {
          const deal = await getRow(dealsDef, user, params.uuid, trx, { forUpdate: true });
          const stage = await trx('pipeline_stages')
            .where({ uuid: body.stageUuid, pipeline_id: deal.pipeline_id, active: true })
            .first();
          if (!stage) throw new AppError('STAGE_INVALID', 'That stage is not part of this pipeline');
          const neighbour = async (uuid: string | null | undefined) =>
            uuid
              ? ((await trx('deals').where({ uuid, stage_id: stage.id }).first('position'))?.position as
                  number | undefined)
              : undefined;
          const before = await neighbour(body.beforeUuid);
          const after = await neighbour(body.afterUuid);
          let position: number;
          if (before !== undefined && after !== undefined) position = (Number(before) + Number(after)) / 2;
          else if (after !== undefined) position = Number(after) - 1000;
          else if (before !== undefined) position = Number(before) + 1000;
          else
            position =
              Number(
                (
                  (await trx('deals').where({ stage_id: stage.id }).max({ m: 'position' }).first()) as {
                    m: number | null;
                  }
                )?.m ?? 0,
              ) + 1000;

          const patch: Record<string, unknown> = { position, updated_by: user.id };
          const stageChanged = stage.id !== deal.stage_id;
          if (stageChanged) {
            const status = statusForStage(stage);
            if (status === 'lost') {
              const { lostReasons } = await getGroup('deals', trx);
              if (lostReasons.length && !body.lostReason)
                throw new AppError('VALIDATION_FAILED', 'Choose why it was lost', [
                  { path: 'lostReason', message: 'Required' },
                ]);
            }
            Object.assign(patch, {
              stage_id: stage.id,
              status,
              stage_entered_at: new Date(),
              won_at: status === 'won' ? new Date() : null,
              lost_at: status === 'lost' ? new Date() : null,
              lost_reason: status === 'lost' ? (body.lostReason ?? null) : null,
            });
          }
          await trx('deals').where({ id: deal.id }).update(patch);
          if (stageChanged) {
            await trx('deal_stage_history').insert({
              deal_id: deal.id,
              from_stage_id: deal.stage_id,
              to_stage_id: stage.id,
              changed_by: user.id,
            });
            await audit(trx, ctx, {
              action: 'deal.stage_changed',
              entity: 'deal',
              entityId: deal.id as number,
              entityUuid: params.uuid,
              diff: {
                stage: { from: deal.stage_id, to: stage.id },
                ...(body.lostReason ? { lost_reason: { from: null, to: body.lostReason } } : {}),
              },
            });
          }
          return {
            row: await trx('deals').where({ id: deal.id }).first(),
            stageChange: stageChanged ? { from: deal.stage_id, to: stage.id } : null,
          };
        });
        const [dto] = await dealsDef.toDtos([updated.row], { user, conn: db });
        if (updated.stageChange)
          await emitDealStage(dto as unknown as Record<string, unknown>, user, {
            stage_id: updated.stageChange,
          });
        return dto!;
      },
    }),
  recordRoutes(dealsDef, 'deals'),
];

export const leadsRoutes = [
  defineRoutes('/leads', ['leads']).add({
    method: 'post',
    path: '/:uuid/convert',
    permission: 'core.leads.update',
    params: z.object({ uuid: z.uuid() }),
    body: leadConvertSchema,
    summary: 'Convert a lead into a contact, optionally an organization and a deal',
    handler: async ({ ctx, user, params, body }) => {
      assertCan(user, 'core.contacts.create');
      if (body.createDeal) assertCan(user, 'core.deals.create');
      return db
        .transaction(async (trx) => {
          const lead = await getRow(leadsDef, user, params.uuid, trx, { forUpdate: true });
          if (lead.converted_at) throw new AppError('CONFLICT', 'This lead was already converted');
          const leadCustom = (lead.custom as Record<string, unknown>) ?? {};
          // Custom values carry over to fields with the same key on the new records.
          const carry = async (entity: 'contact' | 'organization' | 'deal') => {
            const keys = (await trx('custom_field_definitions')
              .where({ entity, active: true })
              .pluck('key')) as string[];
            return Object.fromEntries(Object.entries(leadCustom).filter(([k]) => keys.includes(k)));
          };
          let organizationUuid = body.organizationUuid ?? null;
          if (!organizationUuid && body.createOrganization && lead.company_name) {
            assertCan(user, 'core.organizations.create');
            const org = await createRecord(
              organizationsDef,
              ctx,
              user,
              { name: lead.company_name, custom: await carry('organization') },
              trx,
            );
            organizationUuid = org.uuid;
          }
          const contact = await createRecord(
            contactsDef,
            ctx,
            user,
            {
              firstName: lead.first_name,
              lastName: lead.last_name,
              email: lead.email,
              phone: lead.phone,
              jobTitle: lead.job_title,
              source: lead.source,
              organizationUuid,
              custom: await carry('contact'),
            },
            trx,
          );
          let dealUuid: string | null = null;
          if (body.createDeal) {
            const deal = await createRecord(
              dealsDef,
              ctx,
              user,
              {
                title:
                  body.dealTitle ||
                  lead.company_name ||
                  `${lead.first_name} ${lead.last_name}`.trim() ||
                  'New deal',
                value: body.dealValue ?? 0,
                contactUuid: contact.uuid,
                organizationUuid,
                pipelineUuid: body.pipelineUuid,
              },
              trx,
            );
            dealUuid = deal.uuid;
          }
          const ids = async (table: string, uuid: string | null) =>
            uuid ? ((await trx(table).where({ uuid }).first('id'))?.id as number) : null;
          await trx('leads')
            .where({ id: lead.id })
            .update({
              status: 'converted',
              converted_at: new Date(),
              converted_contact_id: await ids('contacts', contact.uuid),
              converted_organization_id: await ids('organizations', organizationUuid),
              converted_deal_id: await ids('deals', dealUuid),
              updated_by: user.id,
            });
          // Activities logged on the lead follow the new contact.
          await trx('activities')
            .where({ related_type: 'lead', related_id: lead.id })
            .update({ related_type: 'contact', related_id: await ids('contacts', contact.uuid) });
          await audit(trx, ctx, {
            action: 'lead.converted',
            entity: 'lead',
            entityId: lead.id as number,
            entityUuid: params.uuid,
            diff: { contact: contact.uuid, organization: organizationUuid, deal: dealUuid },
          });
          return { contactUuid: contact.uuid, organizationUuid, dealUuid };
        })
        .then(async (r) => {
          await emitRecordEvent(leadsDef, 'converted', { uuid: params.uuid, ...r }, user);
          return r;
        });
    },
  }),
  recordRoutes(leadsDef, 'leads'),
];
