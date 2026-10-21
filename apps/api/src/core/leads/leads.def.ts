import { leadCreateSchema, leadPatchSchema, type LeadDto } from '@app/shared';
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
import { iso, setTags, tagsFilter, tagsFor, userIdFromRef, userRefs } from '../records/hydrate';

type Row = Record<string, unknown> & { id: number };

export const leadsDef: ResourceDef<Row, LeadDto> = {
  entity: 'lead',
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
    owner: ownerField('leads'),
    tags: { kind: 'relation', filter: tagsFilter('lead', 'leads') },
    ...timestampsFields('leads'),
  },
  async toRow(input, { user, conn }) {
    return compact({
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
  },
  async afterWrite(id, input, { user, conn }) {
    if (input.tags) await setTags('lead', id, input.tags as string[], user, conn);
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
    return rows.map((r) => ({
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
      custom: serializeCustom(r.custom, cf.defs, cf.levels),
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      deletedAt: iso(r.deleted_at),
    }));
  },
};
