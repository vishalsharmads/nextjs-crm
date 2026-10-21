import type { CustomFieldDef } from '@app/shared';
import { Check, Minus, Paperclip } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/checkbox';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  fromLocalInput,
  toLocalInput,
} from '@/lib/format';
import { Combobox } from './combobox';
import { UserPicker } from './pickers';

type A11y = { id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string };

/** Input for any custom field type. Values follow the API's storage format. */
export function CustomFieldInput({
  def,
  value,
  onChange,
  disabled,
  ...a11y
}: { def: CustomFieldDef; value: unknown; onChange: (v: unknown) => void; disabled?: boolean } & A11y) {
  const ph = def.placeholder ?? undefined;
  const active = def.options.filter(
    (o) => o.active !== false || (Array.isArray(value) ? value.includes(o.key) : value === o.key),
  );
  switch (def.type) {
    case 'textarea':
      return (
        <Textarea
          {...a11y}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder={ph}
          disabled={disabled}
        />
      );
    case 'number':
    case 'decimal':
    case 'currency':
      return (
        <div className="relative">
          {def.type === 'currency' ? (
            <span className="pointer-events-none absolute inset-y-0 start-2.5 flex items-center text-xs text-muted">
              {def.currency ?? ''}
            </span>
          ) : null}
          <Input
            {...a11y}
            type="number"
            inputMode="decimal"
            step={def.type === 'number' ? 1 : 'any'}
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            className={def.type === 'currency' ? 'ps-12 tabular' : 'tabular'}
            placeholder={ph}
            disabled={disabled}
          />
        </div>
      );
    case 'date':
      return (
        <Input
          {...a11y}
          type="date"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled}
        />
      );
    case 'datetime':
      return (
        <Input
          {...a11y}
          type="datetime-local"
          value={toLocalInput(value as string)}
          onChange={(e) => onChange(fromLocalInput(e.target.value))}
          disabled={disabled}
        />
      );
    case 'boolean':
      return (
        <div className="flex h-8 items-center">
          <Switch
            id={a11y.id}
            checked={value === true}
            onCheckedChange={(v) => onChange(v)}
            disabled={disabled}
            aria-label={def.label}
          />
        </div>
      );
    case 'select':
      return (
        <Combobox
          {...a11y}
          value={(value as string) ?? null}
          onChange={(v) => onChange(v)}
          options={active.map((o) => ({ value: o.key, label: o.label }))}
          disabled={disabled}
        />
      );
    case 'multi_select':
      return (
        <Combobox
          {...a11y}
          multiple
          value={(value as string[]) ?? []}
          onChange={(v) => onChange(v)}
          options={active.map((o) => ({ value: o.key, label: o.label }))}
          disabled={disabled}
        />
      );
    case 'user':
      return (
        <UserPicker {...a11y} value={(value as string) ?? null} onChange={onChange} disabled={disabled} />
      );
    case 'url':
      return (
        <Input
          {...a11y}
          type="url"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder={ph ?? 'https://'}
          disabled={disabled}
        />
      );
    case 'email':
      return (
        <Input
          {...a11y}
          type="email"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder={ph}
          disabled={disabled}
        />
      );
    case 'phone':
      return (
        <Input
          {...a11y}
          type="tel"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder={ph ?? '+44 20 7946 0958'}
          disabled={disabled}
        />
      );
    case 'file':
      return (
        <p className="flex h-8 items-center gap-1.5 text-sm text-muted">
          <Paperclip className="size-3.5" /> Attach files from the Files tab
        </p>
      );
    default:
      return (
        <Input
          {...a11y}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder={ph}
          disabled={disabled}
        />
      );
  }
}

/** Read-only rendering of a custom field value. */
export function CustomFieldDisplay({
  def,
  value,
  users,
}: {
  def: CustomFieldDef;
  value: unknown;
  users?: Map<string, string>;
}) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length))
    return <span className="text-faint">—</span>;
  const label = (k: string) => def.options.find((o) => o.key === k)?.label ?? k;
  switch (def.type) {
    case 'boolean':
      return value ? (
        <Check className="size-4 text-primary" aria-label="Yes" />
      ) : (
        <Minus className="size-4 text-faint" aria-label="No" />
      );
    case 'select':
      return (
        <span className="inline-flex h-5 items-center rounded-sm bg-subtle px-1.5 text-xs">
          {label(value as string)}
        </span>
      );
    case 'multi_select':
      return (
        <span className="flex flex-wrap gap-1">
          {(value as string[]).map((v) => (
            <span key={v} className="inline-flex h-5 items-center rounded-sm bg-subtle px-1.5 text-xs">
              {label(v)}
            </span>
          ))}
        </span>
      );
    case 'currency':
      return <span className="tabular">{formatMoney(value as number, def.currency ?? undefined)}</span>;
    case 'number':
    case 'decimal':
      return <span className="tabular">{formatNumber(value as number, def.validation.scale ?? 4)}</span>;
    case 'date':
      return <>{formatDate(value as string)}</>;
    case 'datetime':
      return <>{formatDateTime(value as string)}</>;
    case 'url':
      return (
        <a
          href={value as string}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-primary hover:underline"
        >
          {(value as string).replace(/^https?:\/\//, '')}
        </a>
      );
    case 'email':
      return (
        <a href={`mailto:${value as string}`} className="truncate text-primary hover:underline">
          {value as string}
        </a>
      );
    case 'phone':
      return (
        <a href={`tel:${value as string}`} className="text-primary hover:underline">
          {value as string}
        </a>
      );
    case 'user':
      return <>{users?.get(value as string) ?? 'User'}</>;
    case 'textarea':
      return <span className="whitespace-pre-wrap">{value as string}</span>;
    default:
      return <>{String(value)}</>;
  }
}
