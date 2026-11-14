import { z } from 'zod';
import { dealMoveSchema, leadConvertSchema, type DealDto, type LeadDto } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { decryptCustom } from '../records/custom';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import { assertCan } from '../rbac/access';
import { createRecord, emitDealStage, emitLeadStage, emitRecordEvent, getRow } from '../records/service';
import { boardQuerySchema, loadBoard, moveToStage } from '../pipelines/board';
import { endOfStage, publicStageChanges, recordStageHistory } from '../pipelines/stage-engine';
import { recordRoutes } from '../records/routes';
import { dealsDef, statusForStage } from './deals.def';
import { leadsDef } from '../leads/leads.def';
import { contactsDef } from '../contacts/contacts.def';
import { organizationsDef } from '../organizations/organizations.def';
import { getGroup } from '../settings/settings.service';

export const dealsRoutes = [
  defineRoutes('/deals', ['deals'])
    .add({
      method: 'get',
      path: '/board',
      permission: 'core.deals.view',
      summary: 'Deals grouped by stage for the Kanban board',
      query: boardQuerySchema,
      handler: async ({ user, query }) => {
        const board = await loadBoard(dealsDef, 'deal', user, query, 'value');
        return {
          pipeline: board.pipeline,
          columns: board.columns.map(({ records, ...c }) => ({ ...c, deals: records })),
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
        const updated = await moveToStage(
          dealsDef,
          'deal',
          ctx,
          user,
          params.uuid,
          body,
          async (stage, trx) => {
            const status = statusForStage(stage);
            if (status === 'lost') {
              const { lostReasons } = await getGroup('deals', trx);
              if (lostReasons.length && !body.lostReason)
                throw new AppError('VALIDATION_FAILED', 'Choose why it was lost', [
                  { path: 'lostReason', message: 'Required' },
                ]);
            }
            return {
              status,
              won_at: status === 'won' ? new Date() : null,
              lost_at: status === 'lost' ? new Date() : null,
              lost_reason: status === 'lost' ? (body.lostReason ?? null) : null,
            };
          },
        );
        const [dto] = await dealsDef.toDtos([updated.row], { user, conn: db });
        if (updated.stageChange)
          await emitDealStage(
            dto as unknown as Record<string, unknown>,
            user,
            await publicStageChanges(db, { stage_id: updated.stageChange }),
          );
        return dto!;
      },
    }),
  recordRoutes(dealsDef, 'deals'),
];

async function assertLeadPipeline() {
  const features = await getGroup('features');
  if (!features.leads || !features.leadPipeline) throw notFound('Lead pipeline');
}

export const leadsRoutes = [
  defineRoutes('/leads', ['leads'])
    .add({
      method: 'get',
      path: '/board',
      permission: 'core.leads.view',
      summary: 'Leads grouped by stage for the Kanban board (lead pipeline feature)',
      query: boardQuerySchema,
      handler: async ({ user, query }) => {
        await assertLeadPipeline();
        const board = await loadBoard(leadsDef, 'lead', user, query);
        return {
          pipeline: board.pipeline,
          columns: board.columns.map(({ records, ...c }) => ({ ...c, leads: records })),
        };
      },
    })
    .add({
      method: 'patch',
      path: '/:uuid/stage',
      permission: 'core.leads.update',
      params: z.object({ uuid: z.uuid() }),
      body: dealMoveSchema,
      summary: 'Move a lead to a stage (and position within it)',
      handler: async ({ ctx, user, params, body }): Promise<LeadDto> => {
        await assertLeadPipeline();
        const updated = await moveToStage(leadsDef, 'lead', ctx, user, params.uuid, body);
        const [dto] = await leadsDef.toDtos([updated.row], { user, conn: db });
        if (updated.stageChange)
          await emitLeadStage(
            dto as unknown as Record<string, unknown>,
            user,
            await publicStageChanges(db, { stage_id: updated.stageChange }),
          );
        return dto!;
      },
    })
    .add({
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
            // Sensitive values are stored encrypted: carry the plain value; the target encrypts it again
            // if it is sensitive too.
            const leadCustom = decryptCustom(lead.custom, 'lead');
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
            // The person's privacy choices go with them: an opt-out or a restriction on the lead
            // must keep automated email and webhooks away from the contact too, and the proof of
            // consent is copied (the ledger is append-only, so the lead keeps its own rows).
            const contactId = (await ids('contacts', contact.uuid))!;
            if (lead.marketing_opt_out || lead.processing_restricted)
              await trx('contacts')
                .where({ id: contactId })
                .update({
                  ...(lead.marketing_opt_out ? { marketing_opt_out: true } : {}),
                  ...(lead.processing_restricted ? { processing_restricted: true } : {}),
                });
            const consents = await trx('consents')
              .where({ subject_type: 'lead', subject_id: lead.id })
              .orderBy('id');
            if (consents.length)
              await trx('consents').insert(
                consents.map(({ id: _id, subject_type: _t, subject_id: _s, created_at, ...row }) => ({
                  ...row,
                  subject_type: 'contact',
                  subject_id: contactId,
                  created_at,
                })),
              );
            await trx('leads')
              .where({ id: lead.id })
              .update({
                status: 'converted',
                converted_at: new Date(),
                converted_contact_id: contactId,
                converted_organization_id: await ids('organizations', organizationUuid),
                converted_deal_id: await ids('deals', dealUuid),
                updated_by: user.id,
              });
            // On the lead pipeline, a converted lead lands on its won stage, like the backfill places it.
            if (lead.pipeline_id) {
              const won = await trx('pipeline_stages')
                .where({ pipeline_id: lead.pipeline_id, active: true, is_won: true })
                .first('id');
              if (won && won.id !== lead.stage_id) {
                await trx('leads')
                  .where({ id: lead.id })
                  .update({
                    stage_id: won.id,
                    stage_entered_at: new Date(),
                    position: await endOfStage(trx, 'lead', won.id),
                  });
                await recordStageHistory(
                  trx,
                  'lead',
                  [lead.id as number],
                  (lead.stage_id as number | null) ?? null,
                  won.id,
                  user.id,
                );
              }
            }
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
