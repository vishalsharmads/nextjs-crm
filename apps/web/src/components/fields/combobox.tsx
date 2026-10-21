import { useState, type ReactNode } from 'react';
import { Command } from 'cmdk';
import { Popover as P } from 'radix-ui';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface ComboOption {
  value: string;
  label: string;
  hint?: string | null;
}

/**
 * Accessible single/multi select with search. When `onSearch` is given, filtering happens
 * server-side (options come from the caller); otherwise cmdk filters locally.
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  onSearch,
  loading,
  disabled,
  clearable = true,
  multiple,
  allowCreate,
  renderValue,
  'aria-invalid': ariaInvalid,
  'aria-describedby': describedBy,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string | string[] | null;
  onChange: (v: string | string[] | null) => void;
  options: ComboOption[];
  placeholder?: string;
  onSearch?: (q: string) => void;
  loading?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  multiple?: boolean;
  /** Offer "Create <query>" (tags). */
  allowCreate?: boolean;
  renderValue?: (selected: ComboOption[]) => ReactNode;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = Array.isArray(value) ? value : value ? [value] : [];
  const known = new Map(options.map((o) => [o.value, o]));
  const selectedOptions = selected.map((v) => known.get(v) ?? { value: v, label: v });

  const pick = (v: string) => {
    if (multiple) {
      onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
      setQ('');
    } else {
      onChange(v);
      setOpen(false);
    }
  };

  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          aria-invalid={ariaInvalid}
          aria-describedby={describedBy}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          className="flex min-h-8 w-full items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 py-1 text-start text-sm transition-colors hover:border-line-strong focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-soft disabled:opacity-60 aria-[invalid=true]:border-accent"
        >
          <span className="flex min-w-0 flex-1 flex-wrap gap-1">
            {selectedOptions.length ? (
              renderValue ? (
                renderValue(selectedOptions)
              ) : multiple ? (
                selectedOptions.map((o) => (
                  <span
                    key={o.value}
                    className="inline-flex h-5 items-center rounded-sm bg-subtle px-1.5 text-xs"
                  >
                    {o.label}
                  </span>
                ))
              ) : (
                <span className="truncate">{selectedOptions[0]!.label}</span>
              )
            ) : (
              <span className="text-faint">{placeholder}</span>
            )}
          </span>
          {clearable && selected.length && !disabled ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Clear"
              onClick={(e) => {
                e.stopPropagation();
                onChange(multiple ? [] : null);
              }}
              className="rounded-sm p-0.5 text-faint hover:bg-hover hover:text-ink"
            >
              <X className="size-3.5" />
            </span>
          ) : (
            <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
          )}
        </button>
      </P.Trigger>
      <P.Portal>
        <P.Content
          align="start"
          sideOffset={4}
          className="anim-pop z-50 w-[var(--radix-popover-trigger-width)] min-w-56 overflow-hidden rounded-md border border-line bg-surface shadow-xl"
        >
          <Command shouldFilter={!onSearch} loop>
            <Command.Input
              value={q}
              onValueChange={(v) => {
                setQ(v);
                onSearch?.(v);
              }}
              placeholder="Search…"
              className="h-9 w-full border-b border-line bg-transparent px-3 text-sm outline-none placeholder:text-faint"
            />
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-4 text-center text-sm text-muted">
                {loading ? 'Loading…' : 'No matches'}
              </Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.hint ?? ''} ${o.value}`}
                  onSelect={() => pick(o.value)}
                  className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[selected=true]:bg-hover"
                >
                  <Check
                    className={cn(
                      'size-3.5 shrink-0 text-primary',
                      !selected.includes(o.value) && 'invisible',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint ? <span className="truncate text-xs text-muted">{o.hint}</span> : null}
                </Command.Item>
              ))}
              {allowCreate &&
              q.trim() &&
              !options.some((o) => o.label.toLowerCase() === q.trim().toLowerCase()) ? (
                <Command.Item
                  value={`__create__ ${q}`}
                  onSelect={() => pick(q.trim())}
                  className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[selected=true]:bg-hover"
                >
                  <span className="text-muted">Create</span> “{q.trim()}”
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
