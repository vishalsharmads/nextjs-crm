import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { conflict, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { getRow } from '../records/service';
import { findContactDuplicates, findOrganizationDuplicates, mergeRecords } from '../records/merge';
import { recordRoutes, uuidParam } from '../records/routes';
import { contactsDef } from './contacts.def';
import { organizationsDef, domainFromWebsite } from '../organizations/organizations.def';

const mergeSchema = z.object({
  primaryUuid: z.uuid(),
  secondaryUuids: z.array(z.uuid()).min(1).max(10),
  pick: z.record(z.string().max(80), z.uuid()).optional(),
});

export const contactsRoutes = [
  defineRoutes('/contacts', ['contacts'])
    .add({
      method: 'post',
      path: '/check-duplicates',
      permission: 'core.contacts.view',
      summary: 'Likely duplicates for a contact about to be created',
      body: z.object({
        email: z.string().max(255).nullish(),
        phone: z.string().max(50).nullish(),
        firstName: z.string().max(100).nullish(),
        lastName: z.string().max(100).nullish(),
      }),
      handler: async ({ user, body }) => ({ data: await findContactDuplicates(user, body) }),
    })
    .add({
      method: 'get',
      path: '/:uuid/duplicates',
      permission: 'core.contacts.view',
      params: uuidParam,
      handler: async ({ user, params }) => {
        const row = await getRow(contactsDef, user, params.uuid);
        return {
          data: await findContactDuplicates(user, {
            email: row.email as string,
            phone: row.phone as string,
            firstName: row.first_name as string,
            lastName: row.last_name as string,
            excludeUuid: params.uuid,
          }),
        };
      },
    })
    .add({
      method: 'post',
      path: '/merge',
      permission: 'core.contacts.merge',
      body: mergeSchema,
      handler: async ({ ctx, user, body }) => ({ uuid: await mergeRecords(contactsDef, ctx, user, body) }),
    })
    .add({
      method: 'post',
      path: '/:uuid/organizations',
      permission: 'core.contacts.update',
      params: uuidParam,
      body: z.object({
        organizationUuid: z.uuid(),
        relationshipType: z.string().trim().min(1).max(50).default('employee'),
        jobTitle: z.string().trim().max(150).nullish(),
        isPrimary: z.boolean().default(false),
      }),
      status: 201,
      handler: async ({ ctx, user, params, body }) => {
        const contact = await getRow(contactsDef, user, params.uuid);
        const org = await getRow(organizationsDef, user, body.organizationUuid);
        await db.transaction(async (trx) => {
          if (
            await trx('contact_organization')
              .where({
                contact_id: contact.id,
                organization_id: org.id,
                relationship_type: body.relationshipType,
              })
              .first()
          ) {
            throw conflict('This link already exists');
          }
          if (body.isPrimary)
            await trx('contact_organization').where({ contact_id: contact.id }).update({ is_primary: false });
          const hasAny = await trx('contact_organization').where({ contact_id: contact.id }).first();
          await trx('contact_organization').insert({
            uuid: newUuid(),
            contact_id: contact.id,
            organization_id: org.id,
            relationship_type: body.relationshipType,
            job_title: body.jobTitle ?? null,
            is_primary: body.isPrimary || !hasAny,
          });
          await audit(trx, ctx, {
            action: 'contact.updated',
            entity: 'contact',
            entityId: contact.id as number,
            entityUuid: params.uuid,
            diff: { organization: { from: null, to: org.name } },
          });
        });
        return { ok: true };
      },
    })
    .add({
      method: 'delete',
      path: '/:uuid/organizations/:linkUuid',
      permission: 'core.contacts.update',
      params: z.object({ uuid: z.uuid(), linkUuid: z.uuid() }),
      handler: async ({ ctx, user, params }) => {
        const contact = await getRow(contactsDef, user, params.uuid);
        await db.transaction(async (trx) => {
          const link = await trx('contact_organization')
            .where({ uuid: params.linkUuid, contact_id: contact.id })
            .first();
          if (!link) throw notFound('Link');
          await trx('contact_organization').where({ id: link.id }).delete();
          if (link.is_primary) {
            const next = await trx('contact_organization')
              .where({ contact_id: contact.id })
              .orderBy('id')
              .first();
            if (next) await trx('contact_organization').where({ id: next.id }).update({ is_primary: true });
          }
          await audit(trx, ctx, {
            action: 'contact.updated',
            entity: 'contact',
            entityId: contact.id as number,
            entityUuid: params.uuid,
            diff: { organization: { from: link.organization_id, to: null } },
          });
        });
      },
    }),
  recordRoutes(contactsDef, 'contacts'),
];

export const organizationsRoutes = [
  defineRoutes('/organizations', ['organizations'])
    .add({
      method: 'post',
      path: '/check-duplicates',
      permission: 'core.organizations.view',
      body: z.object({ name: z.string().max(200).nullish(), website: z.string().max(500).nullish() }),
      handler: async ({ user, body }) => ({
        data: await findOrganizationDuplicates(user, {
          name: body.name,
          domain: domainFromWebsite(body.website ?? null),
        }),
      }),
    })
    .add({
      method: 'get',
      path: '/:uuid/duplicates',
      permission: 'core.organizations.view',
      params: uuidParam,
      handler: async ({ user, params }) => {
        const row = await getRow(organizationsDef, user, params.uuid);
        return {
          data: await findOrganizationDuplicates(user, {
            name: row.name as string,
            domain: row.domain as string,
            excludeUuid: params.uuid,
          }),
        };
      },
    })
    .add({
      method: 'post',
      path: '/merge',
      permission: 'core.organizations.merge',
      body: mergeSchema,
      handler: async ({ ctx, user, body }) => ({
        uuid: await mergeRecords(organizationsDef, ctx, user, body),
      }),
    })
    .add({
      method: 'get',
      path: '/:uuid/contacts',
      permission: 'core.organizations.view',
      params: uuidParam,
      handler: async ({ user, params }) => {
        const org = await getRow(organizationsDef, user, params.uuid);
        const rows = await db('contacts as c')
          .join('contact_organization as co', 'co.contact_id', 'c.id')
          .where('co.organization_id', org.id)
          .whereNull('c.deleted_at')
          .select('c.*');
        if (!rows.length) return { data: [] };
        return { data: await contactsDef.toDtos(rows, { user, conn: db }) };
      },
    }),
  recordRoutes(organizationsDef, 'organizations'),
];
