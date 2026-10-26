import type { Knex } from 'knex';
import { contactCreateSchema, contactPatchSchema, type ContactDto } from '@app/shared';
import { db } from '../../db/knex';
import { newUuid } from '../../lib/ids';
import type { ResourceDef } from '../records/types';
import { serializeCustom } from '../records/custom';
import {
  compact,
  customContext,
  ownerField,
  phoneE164,
  selectField,
  textField,
  timestampsFields,
} from '../records/common';
import { idFromUuid, iso, setTags, tagsFilter, tagsFor, userIdFromRef, userRefs } from '../records/hydrate';

type Row = Record<string, unknown> & { id: number };

export const contactsDef: ResourceDef<Row, ContactDto> = {
  entity: 'contact',
  table: 'contacts',
  resource: 'core.contacts',
  mergeable: true,
  ownerColumns: ['contacts.owner_id'],
  fulltext: ['contacts.full_name', 'contacts.email'],
  likeColumns: ['contacts.full_name', 'contacts.email', 'contacts.phone_e164'],
  notifyColumn: 'owner_id',
  defaultSort: '-created_at',
  createSchema: contactCreateSchema,
  patchSchema: contactPatchSchema,
  fields: {
    full_name: textField('contacts.full_name'),
    first_name: textField('contacts.first_name'),
    last_name: textField('contacts.last_name'),
    email: textField('contacts.email'),
    phone: textField('contacts.phone_e164'),
    job_title: textField('contacts.job_title'),
    source: selectField('contacts.source'),
    lifecycle_status: selectField('contacts.lifecycle_status'),
    owner: ownerField('contacts'),
    tags: { kind: 'relation', filter: tagsFilter('contact', 'contacts') },
    organization: {
      kind: 'relation',
      sortable: true,
      sortExpr:
        '(SELECT o.name FROM contact_organization co JOIN organizations o ON o.id = co.organization_id WHERE co.contact_id = contacts.id ORDER BY co.is_primary DESC, co.id LIMIT 1)',
      filter: (qb, cond) => {
        const values = (Array.isArray(cond.value) ? cond.value : [cond.value]).map(String);
        const exists = (q: Knex.QueryBuilder) =>
          q
            .select(db.raw('1'))
            .from('contact_organization as co')
            .join('organizations as o', 'o.id', 'co.organization_id')
            .whereRaw('co.contact_id = contacts.id')
            .whereIn('o.uuid', values.length ? values : ['']);
        if (cond.op === 'is_empty')
          qb.whereNotExists((q) =>
            q.select(db.raw('1')).from('contact_organization as co').whereRaw('co.contact_id = contacts.id'),
          );
        else if (cond.op === 'neq' || cond.op === 'nin') qb.whereNotExists(exists);
        else qb.whereExists(exists);
      },
    },
    ...timestampsFields('contacts'),
  },
  async toRow(input, { user, conn }) {
    return compact({
      first_name: input.firstName as string | undefined,
      last_name: input.lastName as string | undefined,
      email: input.email as string | null | undefined,
      phone: input.phone as string | null | undefined,
      phone_e164: phoneE164(input.phone as string | null | undefined),
      job_title: input.jobTitle as string | null | undefined,
      source: input.source as string | null | undefined,
      lifecycle_status: input.lifecycleStatus as string | null | undefined,
      owner_id: await userIdFromRef(input.ownerUuid as string | null | undefined, user, conn),
    });
  },
  async afterWrite(id, input, { user, conn }) {
    if (input.tags) await setTags('contact', id, input.tags as string[], user, conn);
    const orgId = await idFromUuid(
      'organizations',
      input.organizationUuid as string | null | undefined,
      'organizationUuid',
      conn,
    );
    if (orgId) {
      const existing = await conn('contact_organization')
        .where({ contact_id: id, organization_id: orgId })
        .first();
      await conn('contact_organization').where({ contact_id: id }).update({ is_primary: false });
      if (existing)
        await conn('contact_organization').where({ id: existing.id }).update({ is_primary: true });
      else
        await conn('contact_organization').insert({
          uuid: newUuid(),
          contact_id: id,
          organization_id: orgId,
          is_primary: true,
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
      tagsFor('contact', ids, conn),
      customContext('contact', user),
    ]);
    const links = ids.length
      ? await conn('contact_organization as co')
          .join('organizations as o', 'o.id', 'co.organization_id')
          .whereIn('co.contact_id', ids)
          .whereNull('o.deleted_at')
          .orderBy([{ column: 'co.is_primary', order: 'desc' }, { column: 'co.id' }])
          .select(
            'co.contact_id',
            'co.uuid',
            'co.relationship_type',
            'co.job_title',
            'co.is_primary',
            'o.uuid as org_uuid',
            'o.name as org_name',
          )
      : [];
    return rows.map((r) => ({
      uuid: r.uuid as string,
      firstName: r.first_name as string,
      lastName: r.last_name as string,
      fullName: (r.full_name as string) || (r.email as string) || '',
      email: (r.email as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      jobTitle: (r.job_title as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      lifecycleStatus: (r.lifecycle_status as string | null) ?? null,
      processingRestricted: !!r.processing_restricted,
      marketingOptOut: !!r.marketing_opt_out,
      owner: owners.get(r.owner_id as number) ?? null,
      tags: tags.get(r.id) ?? [],
      organizations: links
        .filter((l) => l.contact_id === r.id)
        .map((l) => ({
          uuid: l.uuid,
          organization: { uuid: l.org_uuid, name: l.org_name },
          relationshipType: l.relationship_type,
          jobTitle: l.job_title,
          isPrimary: !!l.is_primary,
        })),
      custom: serializeCustom(r.custom, cf.defs, cf.levels),
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      deletedAt: iso(r.deleted_at),
    }));
  },
};
