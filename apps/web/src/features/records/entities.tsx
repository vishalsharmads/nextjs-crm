import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import {
  ENTITY_ROUTE,
  ENTITY_RESOURCE,
  LEAD_STATUSES,
  type ContactDto,
  type CoreEntity,
  type CustomFieldDef,
  type DealDto,
  type LeadDto,
  type OrganizationDto,
  type TagDto,
  type UserRef,
  type VisibilityLevel,
} from '@app/shared';
import { useBoot } from '@/app/session';
import { labelVars } from '@/lib/labels';
import { formatDate, formatMoney, formatRelative } from '@/lib/format';
import { Avatar, Badge } from '@/components/ui/misc';
import { CustomFieldDisplay } from '@/components/fields/custom-field';
import { SensitiveValue } from '@/components/fields/sensitive-value';

export type FieldKind =
  | 'text'
  | 'email'
  | 'phone'
  | 'url'
  | 'money'
  | 'number'
  | 'date'
  | 'datetime'
  | 'select'
  | 'user'
  | 'tags'
  | 'relation'
  | 'textarea'
  | 'custom';

export interface FieldConfig<T = Record<string, unknown>> {
  /** Column id; also the API sort/filter key (custom fields use `cf.<key>`). */
  key: string;
  label: string;
  kind: FieldKind;
  get: (r: T) => unknown;
  render?: (r: T) => ReactNode;
  sortable?: boolean;
  filterable?: boolean;
  /** Choices for select filters/inputs. */
  options?: { value: string; label: string }[];
  /** Record route for relation filters/inputs. */
  relationRoute?: string;
  /** Core input name when the field is editable in forms. */
  input?: string;
  required?: boolean;
  width?: number;
  def?: CustomFieldDef & { level: VisibilityLevel };
  /** Hidden from the column picker (e.g. inputs only). */
  formOnly?: boolean;
}

export interface EntityConfig<T = Record<string, unknown>> {
  entity: CoreEntity;
  route: string;
  resource: string;
  singular: string;
  plural: string;
  title: (r: T) => string;
  subtitle?: (r: T) => string | null;
  fields: FieldConfig<T>[];
  defaultColumns: string[];
  defaultSort: string;
  /** Core form inputs in order (custom fields follow, grouped). */
  formInputs: string[];
  /** Initial form values from a record (edit) or empty (create). */
  toForm: (r?: T) => Record<string, unknown>;
}

const userCell = (u: UserRef | null) =>
  u ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar name={u.name} size="sm" />
      <span className="truncate">{u.name}</span>
    </span>
  ) : (
    <span className="text-faint">—</span>
  );

const tagsCell = (tags: TagDto[]) =>
  tags.length ? (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Badge key={t.uuid}>{t.name}</Badge>
      ))}
    </span>
  ) : null;

const dash = <span className="text-faint">—</span>;
const text = (v: string | null | undefined) => (v ? v : dash);
const link = (to: string, label: string) => (
  <Link to={to} className="truncate hover:underline" onClick={(e) => e.stopPropagation()}>
    {label}
  </Link>
);

function customFieldConfigs<T extends { uuid: string; custom: Record<string, unknown> }>(
  defs: (CustomFieldDef & { level: VisibilityLevel })[],
): FieldConfig<T>[] {
  return defs.map((def) => ({
    key: `cf.${def.key}`,
    label: def.label,
    kind: 'custom',
    get: (r) => r.custom[def.key],
    render: (r) =>
      def.sensitivity === 'special' ? (
        <SensitiveValue def={def} uuid={r.uuid} value={r.custom[def.key]} />
      ) : (
        <CustomFieldDisplay def={def} value={r.custom[def.key]} />
      ),
    sortable: def.filterable && def.type !== 'multi_select',
    filterable: def.filterable,
    options: def.options.map((o) => ({ value: o.key, label: o.label })),
    def,
  }));
}

const common = <T extends { owner: UserRef | null; tags: TagDto[]; createdAt: string; updatedAt: string }>(
  L: Record<string, string>,
): FieldConfig<T>[] => [
  {
    key: 'owner',
    label: 'Owner',
    kind: 'user',
    get: (r) => r.owner?.uuid,
    render: (r) => userCell(r.owner),
    sortable: true,
    filterable: true,
    input: 'ownerUuid',
    width: 160,
  },
  {
    key: 'tags',
    label: L.tagPlural!,
    kind: 'tags',
    get: (r) => r.tags.map((t) => t.name),
    render: (r) => tagsCell(r.tags),
    filterable: true,
    input: 'tags',
    width: 180,
  },
  {
    key: 'created_at',
    label: 'Created',
    kind: 'datetime',
    get: (r) => r.createdAt,
    render: (r) => <span className="text-muted">{formatRelative(r.createdAt)}</span>,
    sortable: true,
    filterable: true,
    width: 120,
  },
  {
    key: 'updated_at',
    label: 'Updated',
    kind: 'datetime',
    get: (r) => r.updatedAt,
    render: (r) => <span className="text-muted">{formatRelative(r.updatedAt)}</span>,
    sortable: true,
    filterable: true,
    width: 120,
  },
];

const opts = (list: string[]) => list.map((v) => ({ value: v, label: v }));

/** Entity configs built from the live bootstrap (vocabulary, settings, custom fields). */
export function useEntityConfig<T = Record<string, unknown>>(entity: CoreEntity): EntityConfig<T> {
  const boot = useBoot();
  return useMemo(() => buildConfig(entity, boot), [entity, boot]) as unknown as EntityConfig<T>;
}

export function buildConfig(entity: CoreEntity, boot: ReturnType<typeof useBoot>): EntityConfig {
  const L = labelVars(boot.labels);
  const defs = boot.customFields.filter((f) => f.entity === entity);
  const { contacts: cs, deals: ds } = boot.settings;
  const base = {
    entity,
    route: ENTITY_ROUTE[entity],
    resource: ENTITY_RESOURCE[entity],
    singular: L[entity]!,
    plural: L[`${entity}Plural`]!,
  };

  if (entity === 'contact') {
    const fields: FieldConfig<ContactDto>[] = [
      {
        key: 'full_name',
        label: 'Name',
        kind: 'text',
        get: (r) => r.fullName,
        sortable: true,
        filterable: true,
        width: 220,
        render: (r) => <span className="font-medium">{r.fullName || r.email || 'Unnamed'}</span>,
      },
      {
        key: 'first_name',
        label: 'First name',
        kind: 'text',
        get: (r) => r.firstName,
        input: 'firstName',
        formOnly: true,
      },
      {
        key: 'last_name',
        label: 'Last name',
        kind: 'text',
        get: (r) => r.lastName,
        input: 'lastName',
        formOnly: true,
      },
      {
        key: 'email',
        label: 'Email',
        kind: 'email',
        get: (r) => r.email,
        render: (r) => text(r.email),
        sortable: true,
        filterable: true,
        input: 'email',
        width: 220,
      },
      {
        key: 'phone',
        label: 'Phone',
        kind: 'phone',
        get: (r) => r.phone,
        render: (r) => text(r.phone),
        sortable: true,
        filterable: true,
        input: 'phone',
        width: 150,
      },
      {
        key: 'job_title',
        label: 'Job title',
        kind: 'text',
        get: (r) => r.jobTitle,
        render: (r) => text(r.jobTitle),
        sortable: true,
        filterable: true,
        input: 'jobTitle',
        width: 160,
      },
      {
        key: 'organization',
        label: L.organization!,
        kind: 'relation',
        relationRoute: 'organizations',
        get: (r) => r.organizations[0]?.organization.uuid,
        render: (r) =>
          r.organizations[0]
            ? link(
                `/organizations/${r.organizations[0].organization.uuid}`,
                r.organizations[0].organization.name,
              )
            : dash,
        sortable: true,
        filterable: true,
        input: 'organizationUuid',
        width: 180,
      },
      {
        key: 'source',
        label: 'Source',
        kind: 'select',
        get: (r) => r.source,
        render: (r) => text(r.source),
        sortable: true,
        filterable: true,
        options: opts(cs.sources),
        input: 'source',
        width: 130,
      },
      {
        key: 'lifecycle_status',
        label: 'Lifecycle',
        kind: 'select',
        get: (r) => r.lifecycleStatus,
        render: (r) => (r.lifecycleStatus ? <Badge tone="outline">{r.lifecycleStatus}</Badge> : dash),
        sortable: true,
        filterable: true,
        options: opts(cs.lifecycleStatuses),
        input: 'lifecycleStatus',
        width: 130,
      },
      ...common<ContactDto>(L),
      ...customFieldConfigs<ContactDto>(defs),
    ];
    return {
      ...base,
      title: (r) => (r as unknown as ContactDto).fullName || (r as unknown as ContactDto).email || 'Unnamed',
      subtitle: (r) => (r as unknown as ContactDto).email,
      fields: fields as unknown as FieldConfig[],
      defaultColumns: ['full_name', 'email', 'phone', 'organization', 'owner', 'created_at'],
      defaultSort: '-created_at',
      formInputs: [
        'firstName',
        'lastName',
        'email',
        'phone',
        'jobTitle',
        'organizationUuid',
        'source',
        'lifecycleStatus',
        'ownerUuid',
        'tags',
      ],
      toForm: (r) => {
        const c = r as unknown as ContactDto | undefined;
        return {
          firstName: c?.firstName ?? '',
          lastName: c?.lastName ?? '',
          email: c?.email ?? '',
          phone: c?.phone ?? '',
          jobTitle: c?.jobTitle ?? '',
          organizationUuid: c?.organizations.find((o) => o.isPrimary)?.organization.uuid ?? null,
          source: c?.source ?? null,
          lifecycleStatus: c?.lifecycleStatus ?? null,
          ownerUuid: c?.owner?.uuid ?? boot.me.uuid,
          tags: c?.tags.map((t) => t.name) ?? [],
          custom: c?.custom ?? {},
        };
      },
    };
  }

  if (entity === 'organization') {
    const fields: FieldConfig<OrganizationDto>[] = [
      {
        key: 'name',
        label: 'Name',
        kind: 'text',
        get: (r) => r.name,
        render: (r) => <span className="font-medium">{r.name}</span>,
        sortable: true,
        filterable: true,
        input: 'name',
        required: true,
        width: 220,
      },
      {
        key: 'website',
        label: 'Website',
        kind: 'url',
        get: (r) => r.website,
        render: (r) => (r.domain ? <span className="text-muted">{r.domain}</span> : dash),
        sortable: true,
        filterable: true,
        input: 'website',
        width: 170,
      },
      {
        key: 'industry',
        label: 'Industry',
        kind: 'text',
        get: (r) => r.industry,
        render: (r) => text(r.industry),
        sortable: true,
        filterable: true,
        input: 'industry',
        width: 150,
      },
      {
        key: 'email',
        label: 'Email',
        kind: 'email',
        get: (r) => r.email,
        render: (r) => text(r.email),
        filterable: true,
        input: 'email',
        width: 200,
      },
      {
        key: 'phone',
        label: 'Phone',
        kind: 'phone',
        get: (r) => r.phone,
        render: (r) => text(r.phone),
        filterable: true,
        input: 'phone',
        width: 150,
      },
      {
        key: 'contact_count',
        label: L.contactPlural!,
        kind: 'number',
        get: (r) => r.contactCount,
        render: (r) => <span className="tabular">{r.contactCount}</span>,
        sortable: true,
        width: 100,
      },
      {
        key: 'address_line1',
        label: 'Address',
        kind: 'text',
        get: (r) => r.addressLine1,
        input: 'addressLine1',
        formOnly: true,
      },
      {
        key: 'address_line2',
        label: 'Address line 2',
        kind: 'text',
        get: (r) => r.addressLine2,
        input: 'addressLine2',
        formOnly: true,
      },
      {
        key: 'city',
        label: 'City',
        kind: 'text',
        get: (r) => r.city,
        render: (r) => text(r.city),
        sortable: true,
        filterable: true,
        input: 'city',
        width: 130,
      },
      { key: 'region', label: 'Region', kind: 'text', get: (r) => r.region, input: 'region', formOnly: true },
      {
        key: 'postal_code',
        label: 'Postal code',
        kind: 'text',
        get: (r) => r.postalCode,
        input: 'postalCode',
        formOnly: true,
      },
      {
        key: 'country',
        label: 'Country',
        kind: 'text',
        get: (r) => r.country,
        render: (r) => text(r.country),
        sortable: true,
        filterable: true,
        input: 'country',
        width: 90,
      },
      ...common<OrganizationDto>(L),
      ...customFieldConfigs<OrganizationDto>(defs),
    ];
    return {
      ...base,
      title: (r) => (r as unknown as OrganizationDto).name,
      subtitle: (r) => (r as unknown as OrganizationDto).domain,
      fields: fields as unknown as FieldConfig[],
      defaultColumns: ['name', 'website', 'industry', 'contact_count', 'owner', 'created_at'],
      defaultSort: 'name',
      formInputs: [
        'name',
        'website',
        'industry',
        'email',
        'phone',
        'addressLine1',
        'addressLine2',
        'city',
        'region',
        'postalCode',
        'country',
        'ownerUuid',
        'tags',
      ],
      toForm: (r) => {
        const o = r as unknown as OrganizationDto | undefined;
        return {
          name: o?.name ?? '',
          website: o?.website ?? '',
          industry: o?.industry ?? '',
          email: o?.email ?? '',
          phone: o?.phone ?? '',
          addressLine1: o?.addressLine1 ?? '',
          addressLine2: o?.addressLine2 ?? '',
          city: o?.city ?? '',
          region: o?.region ?? '',
          postalCode: o?.postalCode ?? '',
          country: o?.country ?? '',
          ownerUuid: o?.owner?.uuid ?? boot.me.uuid,
          tags: o?.tags.map((t) => t.name) ?? [],
          custom: o?.custom ?? {},
        };
      },
    };
  }

  if (entity === 'lead') {
    const statusLabel: Record<string, string> = {
      new: 'New',
      contacted: 'Contacted',
      qualified: 'Qualified',
      unqualified: 'Unqualified',
      converted: 'Converted',
    };
    const fields: FieldConfig<LeadDto>[] = [
      {
        key: 'full_name',
        label: 'Name',
        kind: 'text',
        get: (r) => r.fullName,
        render: (r) => <span className="font-medium">{r.fullName || 'Unnamed'}</span>,
        sortable: true,
        filterable: true,
        width: 200,
      },
      {
        key: 'first_name',
        label: 'First name',
        kind: 'text',
        get: (r) => r.firstName,
        input: 'firstName',
        formOnly: true,
      },
      {
        key: 'last_name',
        label: 'Last name',
        kind: 'text',
        get: (r) => r.lastName,
        input: 'lastName',
        formOnly: true,
      },
      {
        key: 'company_name',
        label: 'Company',
        kind: 'text',
        get: (r) => r.companyName,
        render: (r) => text(r.companyName),
        sortable: true,
        filterable: true,
        input: 'companyName',
        width: 180,
      },
      {
        key: 'email',
        label: 'Email',
        kind: 'email',
        get: (r) => r.email,
        render: (r) => text(r.email),
        sortable: true,
        filterable: true,
        input: 'email',
        width: 200,
      },
      {
        key: 'phone',
        label: 'Phone',
        kind: 'phone',
        get: (r) => r.phone,
        render: (r) => text(r.phone),
        filterable: true,
        input: 'phone',
        width: 140,
      },
      {
        key: 'job_title',
        label: 'Job title',
        kind: 'text',
        get: (r) => r.jobTitle,
        input: 'jobTitle',
        formOnly: true,
      },
      {
        key: 'status',
        label: 'Status',
        kind: 'select',
        get: (r) => r.status,
        render: (r) => (
          <Badge
            tone={r.status === 'qualified' ? 'primary' : r.status === 'unqualified' ? 'accent' : 'neutral'}
          >
            {statusLabel[r.status]}
          </Badge>
        ),
        sortable: true,
        filterable: true,
        options: LEAD_STATUSES.map((s) => ({ value: s, label: statusLabel[s]! })),
        input: 'status',
        width: 120,
      },
      {
        key: 'source',
        label: 'Source',
        kind: 'select',
        get: (r) => r.source,
        render: (r) => text(r.source),
        sortable: true,
        filterable: true,
        options: opts(cs.sources),
        input: 'source',
        width: 130,
      },
      ...common<LeadDto>(L),
      ...customFieldConfigs<LeadDto>(defs),
    ];
    return {
      ...base,
      title: (r) => (r as unknown as LeadDto).fullName || 'Unnamed',
      subtitle: (r) => (r as unknown as LeadDto).companyName,
      fields: fields as unknown as FieldConfig[],
      defaultColumns: ['full_name', 'company_name', 'email', 'status', 'source', 'owner', 'created_at'],
      defaultSort: '-created_at',
      formInputs: [
        'firstName',
        'lastName',
        'companyName',
        'email',
        'phone',
        'jobTitle',
        'status',
        'source',
        'ownerUuid',
        'tags',
      ],
      toForm: (r) => {
        const l = r as unknown as LeadDto | undefined;
        return {
          firstName: l?.firstName ?? '',
          lastName: l?.lastName ?? '',
          companyName: l?.companyName ?? '',
          email: l?.email ?? '',
          phone: l?.phone ?? '',
          jobTitle: l?.jobTitle ?? '',
          status: l?.status === 'converted' ? 'qualified' : (l?.status ?? 'new'),
          source: l?.source ?? null,
          ownerUuid: l?.owner?.uuid ?? boot.me.uuid,
          tags: l?.tags.map((t) => t.name) ?? [],
          custom: l?.custom ?? {},
        };
      },
    };
  }

  // deal
  const pipelines = boot.pipelines.filter((p) => p.entity === 'deal');
  const stageOptions = pipelines.flatMap((p) =>
    p.stages.map((s) => ({ value: s.uuid, label: pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name })),
  );
  const fields: FieldConfig<DealDto>[] = [
    {
      key: 'title',
      label: 'Title',
      kind: 'text',
      get: (r) => r.title,
      render: (r) => (
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <span className="truncate">{r.title}</span>
          {r.rotting ? (
            <AlertTriangle className="size-3.5 shrink-0 text-accent" aria-label="Stalled in this stage" />
          ) : null}
        </span>
      ),
      sortable: true,
      filterable: true,
      input: 'title',
      required: true,
      width: 240,
    },
    {
      key: 'reference',
      label: 'Ref',
      kind: 'text',
      get: (r) => r.reference,
      render: (r) => <span className="tabular text-muted">{r.reference}</span>,
      sortable: true,
      filterable: true,
      width: 80,
    },
    {
      key: 'value',
      label: 'Value',
      kind: 'money',
      get: (r) => r.value,
      render: (r) => <span className="tabular">{formatMoney(r.value, r.currency)}</span>,
      sortable: true,
      filterable: true,
      input: 'value',
      width: 120,
    },
    {
      key: 'stage',
      label: L.stage!,
      kind: 'select',
      get: (r) => r.stage.uuid,
      render: (r) => (
        <Badge tone={r.stage.isWon ? 'primary' : r.stage.isLost ? 'accent' : 'neutral'}>{r.stage.name}</Badge>
      ),
      sortable: true,
      filterable: true,
      options: stageOptions,
      input: 'stageUuid',
      width: 150,
    },
    {
      key: 'pipeline',
      label: L.pipeline!,
      kind: 'select',
      get: (r) => r.pipeline.uuid,
      render: (r) => text(r.pipeline.name),
      sortable: true,
      filterable: true,
      options: pipelines.map((p) => ({ value: p.uuid, label: p.name })),
      input: 'pipelineUuid',
      width: 140,
      formOnly: pipelines.length < 2,
    },
    {
      key: 'contact',
      label: L.contact!,
      kind: 'relation',
      relationRoute: 'contacts',
      get: (r) => r.contact?.uuid,
      render: (r) => (r.contact ? link(`/contacts/${r.contact.uuid}`, r.contact.name) : dash),
      sortable: true,
      filterable: true,
      input: 'contactUuid',
      width: 170,
    },
    {
      key: 'organization',
      label: L.organization!,
      kind: 'relation',
      relationRoute: 'organizations',
      get: (r) => r.organization?.uuid,
      render: (r) =>
        r.organization ? link(`/organizations/${r.organization.uuid}`, r.organization.name) : dash,
      sortable: true,
      filterable: true,
      input: 'organizationUuid',
      width: 170,
    },
    {
      key: 'expected_close',
      label: 'Expected close',
      kind: 'date',
      get: (r) => r.expectedClose,
      render: (r) => (r.expectedClose ? formatDate(r.expectedClose) : dash),
      sortable: true,
      filterable: true,
      input: 'expectedClose',
      width: 130,
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'select',
      get: (r) => r.status,
      render: (r) => <span className="capitalize">{r.status}</span>,
      sortable: true,
      filterable: true,
      options: [
        { value: 'open', label: 'Open' },
        { value: 'won', label: 'Won' },
        { value: 'lost', label: 'Lost' },
      ],
      width: 90,
    },
    {
      key: 'lost_reason',
      label: 'Lost reason',
      kind: 'select',
      get: (r) => r.lostReason,
      render: (r) => text(r.lostReason),
      sortable: true,
      filterable: true,
      options: opts(ds.lostReasons),
      width: 150,
    },
    ...common<DealDto>(L),
    ...customFieldConfigs<DealDto>(defs),
  ];
  return {
    ...base,
    title: (r) => (r as unknown as DealDto).title,
    subtitle: (r) =>
      (r as unknown as DealDto).organization?.name ?? (r as unknown as DealDto).contact?.name ?? null,
    fields: fields as unknown as FieldConfig[],
    defaultColumns: ['title', 'organization', 'stage', 'value', 'expected_close', 'owner'],
    defaultSort: '-created_at',
    formInputs: [
      'title',
      'value',
      'pipelineUuid',
      'stageUuid',
      'contactUuid',
      'organizationUuid',
      'expectedClose',
      'ownerUuid',
      'tags',
    ],
    toForm: (r) => {
      const d = r as unknown as DealDto | undefined;
      const defaultPipeline = pipelines.find((p) => p.isDefault) ?? pipelines[0];
      return {
        title: d?.title ?? '',
        value: d?.value ?? 0,
        pipelineUuid: d?.pipeline.uuid ?? defaultPipeline?.uuid ?? null,
        stageUuid: d?.stage.uuid ?? defaultPipeline?.stages.find((s) => !s.isWon && !s.isLost)?.uuid ?? null,
        contactUuid: d?.contact?.uuid ?? null,
        organizationUuid: d?.organization?.uuid ?? null,
        expectedClose: d?.expectedClose ?? '',
        ownerUuid: d?.owner?.uuid ?? boot.me.uuid,
        tags: d?.tags.map((t) => t.name) ?? [],
        custom: d?.custom ?? {},
        _contactLabel: d?.contact?.name,
        _organizationLabel: d?.organization?.name,
      };
    },
  };
}
