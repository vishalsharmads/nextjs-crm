import { useState } from 'react';
import { Filter, Plus, X } from 'lucide-react';
import type { FilterCondition, FilterOp } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { Combobox } from '@/components/fields/combobox';
import { RecordPicker, TagsInput, UserPicker } from '@/components/fields/pickers';
import type { FieldConfig } from '@/features/records/entities';

const OPS: Record<string, { op: FilterOp; label: string }[]> = {
  text: [
    { op: 'contains', label: 'contains' },
    { op: 'eq', label: 'is' },
    { op: 'starts_with', label: 'starts with' },
    { op: 'is_empty', label: 'is empty' },
    { op: 'is_not_empty', label: 'is not empty' },
  ],
  number: [
    { op: 'eq', label: '=' },
    { op: 'gt', label: '>' },
    { op: 'gte', label: '≥' },
    { op: 'lt', label: '<' },
    { op: 'lte', label: '≤' },
    { op: 'is_empty', label: 'is empty' },
  ],
  date: [
    { op: 'within_last_days', label: 'in the last … days' },
    { op: 'within_next_days', label: 'in the next … days' },
    { op: 'today', label: 'is today' },
    { op: 'gte', label: 'on or after' },
    { op: 'lte', label: 'on or before' },
    { op: 'is_empty', label: 'is empty' },
  ],
  select: [
    { op: 'in', label: 'is any of' },
    { op: 'nin', label: 'is none of' },
    { op: 'is_empty', label: 'is empty' },
    { op: 'is_not_empty', label: 'is not empty' },
  ],
  boolean: [
    { op: 'eq', label: 'is' },
    { op: 'is_empty', label: 'is empty' },
  ],
  user: [
    { op: 'in', label: 'is' },
    { op: 'nin', label: 'is not' },
    { op: 'is_empty', label: 'is unassigned' },
  ],
  relation: [
    { op: 'eq', label: 'is' },
    { op: 'is_empty', label: 'is empty' },
    { op: 'is_not_empty', label: 'is not empty' },
  ],
  tags: [
    { op: 'in', label: 'has any of' },
    { op: 'nin', label: 'has none of' },
    { op: 'is_empty', label: 'has no tags' },
  ],
};

/** Map a field to the operator family it supports. */
function family(f: FieldConfig): keyof typeof OPS {
  if (f.def) {
    const t = f.def.type;
    if (t === 'number' || t === 'decimal' || t === 'currency') return 'number';
    if (t === 'date' || t === 'datetime') return 'date';
    if (t === 'select' || t === 'multi_select') return 'select';
    if (t === 'boolean') return 'boolean';
    if (t === 'user') return 'user';
    return 'text';
  }
  switch (f.kind) {
    case 'money':
    case 'number':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'select':
      return 'select';
    case 'user':
      return 'user';
    case 'relation':
      return 'relation';
    case 'tags':
      return 'tags';
    default:
      return 'text';
  }
}

const NO_VALUE: FilterOp[] = ['is_empty', 'is_not_empty', 'today'];

export function describe(c: FilterCondition, field: FieldConfig | undefined): string {
  const fam = field ? family(field) : 'text';
  const op = OPS[fam]?.find((o) => o.op === c.op)?.label ?? c.op;
  if (NO_VALUE.includes(c.op)) return `${field?.label ?? c.field} ${op}`;
  const values = Array.isArray(c.value) ? c.value : [c.value];
  const shown = values
    .map((v) => (v === '@me' ? 'me' : (field?.options?.find((o) => o.value === v)?.label ?? String(v))))
    .join(', ');
  const valueText = c.op.startsWith('within_') ? op.replace('…', shown) : `${op} ${shown}`;
  return `${field?.label ?? c.field} ${c.op.startsWith('within_') ? valueText : valueText}`;
}

export function FilterBar({
  fields,
  conditions,
  onChange,
}: {
  fields: FieldConfig[];
  conditions: FilterCondition[];
  onChange: (c: FilterCondition[]) => void;
}) {
  const filterable = fields.filter((f) => f.filterable);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {conditions.map((c, i) => (
        <FilterChip
          key={`${c.field}-${i}`}
          field={byKey.get(c.field)}
          condition={c}
          onChange={(next) => onChange(conditions.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(conditions.filter((_, j) => j !== i))}
        />
      ))}
      <AddFilter
        fields={filterable}
        onAdd={(c) => onChange([...conditions, c])}
        hasAny={conditions.length > 0}
      />
      {conditions.length ? (
        <Button size="sm" variant="ghost" onClick={() => onChange([])}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}

function FilterChip({
  field,
  condition,
  onChange,
  onRemove,
}: {
  field?: FieldConfig;
  condition: FilterCondition;
  onChange: (c: FilterCondition) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="inline-flex h-7 items-center rounded-sm border border-line bg-surface text-xs">
        <PopoverTrigger asChild>
          <button type="button" className="max-w-72 truncate px-2 hover:text-primary">
            {describe(condition, field)}
          </button>
        </PopoverTrigger>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove filter"
          className="flex h-full items-center border-s border-line px-1.5 text-faint hover:bg-hover hover:text-ink"
        >
          <X className="size-3" />
        </button>
      </span>
      <PopoverContent className="w-80">
        {field ? (
          <ConditionEditor
            field={field}
            initial={condition}
            onApply={(c) => {
              onChange(c);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function AddFilter({
  fields,
  onAdd,
  hasAny,
}: {
  fields: FieldConfig[];
  onAdd: (c: FilterCondition) => void;
  hasAny: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<FieldConfig | null>(null);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setField(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant={hasAny ? 'ghost' : 'secondary'}>
          {hasAny ? <Plus /> : <Filter />} {hasAny ? 'Add filter' : 'Filter'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        {field ? (
          <ConditionEditor
            field={field}
            onApply={(c) => {
              onAdd(c);
              setOpen(false);
              setField(null);
            }}
          />
        ) : (
          <div className="flex max-h-72 flex-col overflow-y-auto">
            {fields.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setField(f)}
                className="rounded-sm px-2 py-1.5 text-start text-sm hover:bg-hover"
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ConditionEditor({
  field,
  initial,
  onApply,
}: {
  field: FieldConfig;
  initial?: FilterCondition;
  onApply: (c: FilterCondition) => void;
}) {
  const fam = family(field);
  const ops = OPS[fam]!;
  const [op, setOp] = useState<FilterOp>(initial?.op ?? ops[0]!.op);
  const [value, setValue] = useState<unknown>(
    initial?.value ??
      (fam === 'select' || fam === 'user' || fam === 'tags' ? [] : fam === 'boolean' ? true : ''),
  );
  const needsValue = !NO_VALUE.includes(op);
  const apply = () =>
    onApply({ field: field.key, op, ...(needsValue ? { value: value as FilterCondition['value'] } : {}) });

  let input = null;
  if (needsValue) {
    if (fam === 'select') {
      input = (
        <Combobox
          multiple
          value={(value as string[]) ?? []}
          onChange={(v) => setValue(v)}
          options={field.options ?? []}
        />
      );
    } else if (fam === 'user') {
      const arr = (value as string[]) ?? [];
      input = (
        <div className="flex flex-col gap-2">
          <UserPicker
            value={arr[0] && arr[0] !== '@me' ? arr[0] : null}
            onChange={(v) => setValue(v ? [v] : [])}
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={arr.includes('@me')}
              onChange={(e) => setValue(e.target.checked ? ['@me'] : [])}
            />{' '}
            Me (whoever is viewing)
          </label>
        </div>
      );
    } else if (fam === 'tags') {
      input = (
        <TagsInput
          value={(value as string[]) ?? []}
          onChange={(v) => setValue(v.map((n) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')))}
        />
      );
    } else if (fam === 'relation') {
      input = (
        <RecordPicker
          route={field.relationRoute!}
          value={(value as string) || null}
          onChange={(v) => setValue(v ?? '')}
        />
      );
    } else if (fam === 'boolean') {
      input = (
        <Combobox
          clearable={false}
          value={value === false ? 'false' : 'true'}
          onChange={(v) => setValue(v === 'true')}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
      );
    } else if (fam === 'date') {
      input = op.startsWith('within_') ? (
        <Input
          type="number"
          min={0}
          value={String(value ?? '')}
          onChange={(e) => setValue(Number(e.target.value))}
          placeholder="Days"
        />
      ) : (
        <Input type="date" value={String(value ?? '')} onChange={(e) => setValue(e.target.value)} />
      );
    } else if (fam === 'number') {
      input = (
        <Input
          type="number"
          value={String(value ?? '')}
          onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))}
        />
      );
    } else {
      input = (
        <Input
          value={String(value ?? '')}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
          autoFocus
        />
      );
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted">{field.label}</p>
      <Combobox
        clearable={false}
        value={op}
        onChange={(v) => setOp(v as FilterOp)}
        options={ops.map((o) => ({ value: o.op, label: o.label }))}
      />
      {input}
      <Button
        size="sm"
        variant="primary"
        onClick={apply}
        disabled={needsValue && (value === '' || (Array.isArray(value) && !value.length))}
      >
        Apply
      </Button>
    </div>
  );
}
