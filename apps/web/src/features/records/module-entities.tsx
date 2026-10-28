import type { ReactNode } from 'react';
import {
  ENTITY_ROUTE,
  recordTypePath,
  type CustomFieldDef,
  type RecordColumnMeta,
  type RecordTypeMeta,
  type UserRef,
  type VisibilityLevel,
} from '@app/shared';
import { formatDate, formatMoney, formatRelative } from '@/lib/format';
import { Avatar } from '@/components/ui/misc';
import { CustomFieldDisplay } from '@/components/fields/custom-field';
import { SensitiveValue } from '@/components/fields/sensitive-value';
import type { EntityConfig, FieldConfig, FieldKind } from './entities';

type Rec = Record<string, unknown> & {
  uuid: string;
  owner: UserRef | null;
  custom: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type Vocabulary = Record<string, { singular: string; plural: string } | undefined>;

const dash = <span className="text-faint">—</span>;

const KIND: Record<RecordColumnMeta['kind'], FieldKind> = {
  text: 'text',
  textarea: 'textarea',
  email: 'email',
  phone: 'phone',
  url: 'url',
  number: 'number',
  money: 'money',
  date: 'date',
  datetime: 'datetime',
  boolean: 'select',
  select: 'select',
  user: 'user',
  relation: 'relation',
};

const YES_NO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

function render(c: RecordColumnMeta, v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return dash;
  switch (c.kind) {
    case 'money':
      return <span className="tabular">{formatMoney(Number(v), c.currency)}</span>;
    case 'number':
      return <span className="tabular">{String(v)}</span>;
    case 'date':
      return formatDate(String(v));
    case 'datetime':
      return formatRelative(String(v));
    case 'boolean':
      return v ? 'Yes' : 'No';
    case 'select':
      return c.options?.find((o) => o.value === v)?.label ?? String(v);
    case 'relation':
      return (v as { name: string }).name;
    default:
      return <span className="truncate">{String(v)}</span>;
  }
}

function columnField(c: RecordColumnMeta, title: boolean, vocab: Vocabulary): FieldConfig<Rec> {
  const relation = c.kind === 'relation';
  return {
    key: c.key,
    // A relation names a core entity: use its vocabulary, not the module's literal label.
    label: relation && c.relation ? (vocab[c.relation]?.singular ?? c.label) : c.label,
    kind: KIND[c.kind],
    get: (r) => (relation ? (r[c.key] as { uuid: string } | null)?.uuid : r[c.key]),
    render: (r) => (title ? <span className="font-medium">{render(c, r[c.key])}</span> : render(c, r[c.key])),
    sortable: c.sortable,
    filterable: c.filterable,
    options: c.kind === 'boolean' ? YES_NO : c.options,
    relationRoute: relation && c.relation ? ENTITY_ROUTE[c.relation] : undefined,
    input: relation ? `${c.key}Uuid` : c.key,
    required: c.required,
    width: title ? 220 : c.kind === 'textarea' ? 240 : 150,
  };
}

function customField(def: CustomFieldDef & { level: VisibilityLevel }): FieldConfig<Rec> {
  return {
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
  };
}

/** Entity config of a module record type, built from its bootstrap metadata. */
export function buildModuleConfig(
  meta: RecordTypeMeta,
  labels: { singular: string; plural: string },
  vocab: Vocabulary,
  customFields: (CustomFieldDef & { level: VisibilityLevel })[],
  me: { uuid: string },
): EntityConfig {
  const fields: FieldConfig<Rec>[] = [
    ...meta.columns.map((c) => columnField(c, c.key === meta.titleColumn, vocab)),
    {
      key: 'owner',
      label: 'Owner',
      kind: 'user',
      get: (r) => r.owner?.uuid,
      render: (r) =>
        r.owner ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Avatar name={r.owner.name} size="sm" />
            <span className="truncate">{r.owner.name}</span>
          </span>
        ) : (
          dash
        ),
      sortable: true,
      filterable: true,
      input: 'ownerUuid',
      width: 160,
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
    ...customFields.filter((d) => d.entity === meta.entity).map(customField),
  ];
  const editable = meta.columns.filter((c) => c.kind !== 'datetime');
  return {
    entity: meta.entity,
    route: recordTypePath(meta),
    resource: meta.resource,
    singular: labels.singular,
    plural: labels.plural,
    moduleKey: meta.moduleKey,
    title: (r) => String((r as Rec)[meta.titleColumn] ?? '') || 'Unnamed',
    subtitle: () => null,
    fields: fields as unknown as FieldConfig[],
    defaultColumns: meta.defaultColumns,
    defaultSort: meta.defaultSort,
    formInputs: [...editable.map((c) => (c.kind === 'relation' ? `${c.key}Uuid` : c.key)), 'ownerUuid'],
    toForm: (r) => {
      const rec = r as unknown as Rec | undefined;
      const values: Record<string, unknown> = {
        ownerUuid: rec?.owner?.uuid ?? me.uuid,
        custom: rec?.custom ?? {},
      };
      for (const c of editable) {
        const v = rec?.[c.key];
        if (c.kind === 'relation') {
          const rel = v as { uuid: string; name: string } | null | undefined;
          values[`${c.key}Uuid`] = rel?.uuid ?? null;
          values[`_${c.key}Label`] = rel?.name;
        } else if (c.kind === 'boolean') values[c.key] = v === undefined || v === null ? null : String(v);
        else if (c.kind === 'number' || c.kind === 'money') values[c.key] = v ?? null;
        else values[c.key] = v ?? (c.kind === 'select' ? null : '');
      }
      return values;
    },
  };
}
