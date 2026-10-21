import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Pencil } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useCan } from '@/app/session';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { useRecordMutations } from './api';
import type { EntityConfig, FieldConfig } from './entities';
import { FieldInputControl, useFormSections } from './record-form';

type Rec = Record<string, unknown> & { uuid: string; custom: Record<string, unknown> };

/** Field list with click-to-edit. Each save sends only that field; the toast offers undo. */
export function FieldsPanel({
  config,
  record,
  compact,
}: {
  config: EntityConfig;
  record: Rec;
  compact?: boolean;
}) {
  const sections = useFormSections(config);
  const can = useCan();
  const editable = can(`${config.resource}.update`);
  return (
    <div className="flex flex-col gap-5">
      {sections.map((s) => (
        <section key={s.key}>
          <h3 className="mb-1.5 text-xs font-semibold text-muted">{s.label}</h3>
          <dl className={cn('grid gap-x-4', compact ? 'grid-cols-1' : 'grid-cols-[minmax(120px,40%)_1fr]')}>
            {s.fields.map((f) => (
              <FieldRow
                key={f.key}
                config={config}
                field={f}
                record={record}
                editable={editable && (!f.def || f.def.level === 'write')}
                compact={compact}
              />
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function FieldRow({
  config,
  field,
  record,
  editable,
  compact,
}: {
  config: EntityConfig;
  field: FieldConfig;
  record: Rec;
  editable: boolean;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const display = field.render ? (
    field.render(record)
  ) : (
    <span>{String(field.get(record) ?? '') || <span className="text-faint">—</span>}</span>
  );
  return (
    <div className={cn('contents', compact && 'flex flex-col py-1')}>
      <dt className={cn('truncate py-1.5 text-sm text-muted', compact && 'py-0 text-xs')}>{field.label}</dt>
      <dd className="min-w-0 py-0.5">
        {editing ? (
          <InlineEditor config={config} field={field} record={record} onDone={() => setEditing(false)} />
        ) : (
          <button
            type="button"
            disabled={!editable}
            onClick={() => setEditing(true)}
            className={cn(
              'group flex min-h-8 w-full items-center gap-2 rounded-sm px-1.5 text-start text-sm',
              editable && 'hover:bg-hover',
            )}
            aria-label={editable ? `Edit ${field.label}` : undefined}
          >
            <span className="min-w-0 flex-1 truncate">{display}</span>
            {editable ? (
              <Pencil className="size-3 shrink-0 text-faint opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            ) : null}
          </button>
        )}
      </dd>
    </div>
  );
}

function InlineEditor({
  config,
  field,
  record,
  onDone,
}: {
  config: EntityConfig;
  field: FieldConfig;
  record: Rec;
  onDone: () => void;
}) {
  const initial = config.toForm(record as never) as Record<string, unknown> & {
    custom: Record<string, unknown>;
  };
  const form = useForm({ defaultValues: initial });
  const { update } = useRecordMutations<Rec>(config.route);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input,textarea,button')?.focus();
  }, []);

  const save = form.handleSubmit(async (values) => {
    const input = field.def
      ? { custom: { [field.def.key]: values.custom?.[field.def.key] ?? null } }
      : { [field.input!]: values[field.input!] };
    const before = field.def
      ? { custom: { [field.def.key]: initial.custom?.[field.def.key] ?? null } }
      : { [field.input!]: initial[field.input!] };
    if (JSON.stringify(input) === JSON.stringify(before)) return onDone();
    try {
      await update.mutateAsync({ uuid: record.uuid, input });
      onDone();
      toast.success(`${field.label} updated`, {
        action: { label: 'Undo', onClick: () => update.mutate({ uuid: record.uuid, input: before }) },
      });
    } catch (err) {
      const fe = err instanceof ApiError ? err.fieldErrors() : {};
      const key = field.def ? `custom.${field.def.key}` : field.input!;
      form.setError(key as never, {
        message: fe[key] ?? (err instanceof Error ? err.message : 'Could not save'),
      });
    }
  });

  return (
    <form
      ref={ref}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
      className="flex flex-col gap-1.5 rounded-sm border border-primary bg-surface p-2 [&_label]:sr-only"
    >
      <FieldInputControl
        field={field}
        control={form.control}
        labels={{
          contactUuid: (record.contact as { name?: string } | null)?.name,
          organizationUuid: (record.organization as { name?: string } | null)?.name,
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" loading={update.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}
