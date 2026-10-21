import { organizationInputSchema, organizationPatchSchema, type OrganizationDto } from '@app/shared';
import type { ResourceDef } from '../records/types';
import { serializeCustom } from '../records/custom';
import {
  compact,
  customContext,
  ownerField,
  selectField,
  textField,
  timestampsFields,
} from '../records/common';
import { iso, setTags, tagsFilter, tagsFor, userIdFromRef, userRefs } from '../records/hydrate';

type Row = Record<string, unknown> & { id: number };

export function domainFromWebsite(website: string | null | undefined): string | null | undefined {
  if (website === undefined) return undefined;
  if (!website) return null;
  try {
    return new URL(website).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export const organizationsDef: ResourceDef<Row, OrganizationDto> = {
  entity: 'organization',
  table: 'organizations',
  resource: 'core.organizations',
  ownerColumns: ['organizations.owner_id'],
  fulltext: ['organizations.name', 'organizations.domain'],
  likeColumns: ['organizations.name', 'organizations.domain'],
  defaultSort: 'name',
  createSchema: organizationInputSchema,
  patchSchema: organizationPatchSchema,
  fields: {
    name: textField('organizations.name'),
    domain: textField('organizations.domain'),
    website: textField('organizations.website'),
    industry: selectField('organizations.industry'),
    city: textField('organizations.city'),
    country: selectField('organizations.country'),
    email: textField('organizations.email'),
    phone: textField('organizations.phone'),
    owner: ownerField('organizations'),
    tags: { kind: 'relation', filter: tagsFilter('organization', 'organizations') },
    contact_count: {
      kind: 'number',
      sortable: true,
      filterable: false,
      sortExpr: '(SELECT COUNT(*) FROM contact_organization co WHERE co.organization_id = organizations.id)',
    },
    ...timestampsFields('organizations'),
  },
  async toRow(input, { user, conn }) {
    return compact({
      name: input.name as string | undefined,
      website: input.website as string | null | undefined,
      domain: domainFromWebsite(input.website as string | null | undefined),
      industry: input.industry as string | null | undefined,
      email: input.email as string | null | undefined,
      phone: input.phone as string | null | undefined,
      address_line1: input.addressLine1 as string | null | undefined,
      address_line2: input.addressLine2 as string | null | undefined,
      city: input.city as string | null | undefined,
      region: input.region as string | null | undefined,
      postal_code: input.postalCode as string | null | undefined,
      country: input.country as string | null | undefined,
      owner_id: await userIdFromRef(input.ownerUuid as string | null | undefined, user, conn),
    });
  },
  async afterWrite(id, input, { user, conn }) {
    if (input.tags) await setTags('organization', id, input.tags as string[], user, conn);
  },
  async toDtos(rows, { user, conn }) {
    const ids = rows.map((r) => r.id);
    const [owners, tags, cf] = await Promise.all([
      userRefs(
        rows.map((r) => r.owner_id as number | null),
        conn,
      ),
      tagsFor('organization', ids, conn),
      customContext('organization', user),
    ]);
    const counts = ids.length
      ? await conn('contact_organization as co')
          .join('contacts as c', 'c.id', 'co.contact_id')
          .whereNull('c.deleted_at')
          .whereIn('co.organization_id', ids)
          .groupBy('co.organization_id')
          .select('co.organization_id')
          .count({ n: '*' })
      : [];
    return rows.map((r) => ({
      uuid: r.uuid as string,
      name: r.name as string,
      website: (r.website as string | null) ?? null,
      domain: (r.domain as string | null) ?? null,
      industry: (r.industry as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      addressLine1: (r.address_line1 as string | null) ?? null,
      addressLine2: (r.address_line2 as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      region: (r.region as string | null) ?? null,
      postalCode: (r.postal_code as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      owner: owners.get(r.owner_id as number) ?? null,
      tags: tags.get(r.id) ?? [],
      contactCount: Number(
        (counts as { organization_id: number; n: number }[]).find((c) => c.organization_id === r.id)?.n ?? 0,
      ),
      custom: serializeCustom(r.custom, cf.defs, cf.levels),
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      deletedAt: iso(r.deleted_at),
    }));
  },
};
