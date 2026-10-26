import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Control, type UseFormSetError } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import type { DuplicateCandidate, LayoutSection } from '@app/shared';
import { ApiError, apiPost } from '@/lib/api';
import { basePath } from '@/lib/app-url';
import { useBoot } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/dialog';
import { CustomFieldInput } from '@/components/fields/custom-field';
import { ListSelect, RecordPicker, TagsInput, UserPicker } from '@/components/fields/pickers';
import { Combobox } from '@/components/fields/combobox';
import { useRecordMutations } from './api';
import type { EntityConfig, FieldConfig } from './entities';

type Values = Record<string, unknown> & { custom: Record<string, unknown> };

/** Sections for the form: the configured layout if any, otherwise core + one per custom field group. */
export function useFormSections(
  config: EntityConfig,
): { key: string; label: string; fields: FieldConfig[] }[] {
  const boot = useBoot();
  return useMemo(() => {
    const byInput = new Map(config.fields.filter((f) => f.input).map((f) => [f.input!, f]));
    const byKey = new Map(config.fields.map((f) => [f.key, f]));
    const layout = boot.layouts.find((l) => l.entity === config.entity && l.context === 'form');
    const writableCustom = config.fields.filter((f) => f.def && f.def.level !== 'hidden');
    if (layout?.sections?.length) {
      const used = new Set<string>();
      const sections = layout.sections.map((s: LayoutSection) => ({
        key: s.key,
        label: s.label,
        fields: s.fields
          .map((ref) => (ref.startsWith('cf.') ? byKey.get(ref) : (byKey.get(ref) ?? byInput.get(ref))))
          .filter((f): f is FieldConfig => !!f && (!!f.input || !!f.def))
          .filter((f) => (used.has(f.key) ? false : (used.add(f.key), true))),
      }));
      const rest = [
        ...config.formInputs.map((i) => byInput.get(i)!).filter(Boolean),
        ...writableCustom,
      ].filter((f) => !used.has(f.key));
      if (rest.length) sections.push({ key: 'other', label: 'Other', fields: rest });
      return sections;
    }
    const core = config.formInputs.map((i) => byInput.get(i)).filter((f): f is FieldConfig => !!f);
    const groups = boot.fieldGroups
      .filter((g) => g.entity === config.entity)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const sections = [{ key: 'details', label: 'Details', fields: core }];
    for (const g of groups) {
      const fields = writableCustom.filter((f) => f.def!.group === g.key);
      if (fields.length) sections.push({ key: g.key, label: g.label, fields });
    }
    const ungrouped = writableCustom.filter(
      (f) => !f.def!.group || !groups.some((g) => g.key === f.def!.group),
    );
    if (ungrouped.length) sections.push({ key: 'more', label: 'More details', fields: ungrouped });
    return sections;
  }, [config, boot.layouts, boot.fieldGroups]);
}

/** One input for a core or custom field, wired to react-hook-form. */
export function FieldInputControl({
  field,
  control,
  labels,
  setLabel,
}: {
  field: FieldConfig;
  control: Control<Values>;
  labels?: Record<string, string | undefined>;
  setLabel?: (k: string, v?: string) => void;
}) {
  const boot = useBoot();
  if (field.def) {
    const def = field.def;
    return (
      <Controller
        control={control}
        name={`custom.${def.key}`}
        render={({ field: f, fieldState }) => (
          <Field
            label={def.label}
            required={def.required}
            error={fieldState.error?.message}
            help={def.helpText ?? undefined}
          >
            {(p) => (
              <CustomFieldInput
                {...p}
                def={def}
                value={f.value}
                onChange={f.onChange}
                disabled={def.level !== 'write'}
              />
            )}
          </Field>
        )}
      />
    );
  }
  const name = field.input!;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field: f, fieldState }) => (
        <Field label={field.label} required={field.required} error={fieldState.error?.message}>
          {(p): ReactNode => {
            switch (field.kind) {
              case 'user':
                return <UserPicker {...p} value={(f.value as string) ?? null} onChange={f.onChange} />;
              case 'tags':
                return <TagsInput {...p} value={(f.value as string[]) ?? []} onChange={f.onChange} />;
              case 'relation':
                return (
                  <RecordPicker
                    {...p}
                    route={field.relationRoute!}
                    value={(f.value as string) ?? null}
                    label={labels?.[name]}
                    onChange={(v, l) => (f.onChange(v), setLabel?.(name, l))}
                  />
                );
              case 'select':
                if (name === 'stageUuid')
                  return (
                    <StageSelect
                      {...p}
                      value={(f.value as string) ?? null}
                      onChange={f.onChange}
                      control={control}
                    />
                  );
                if (name === 'pipelineUuid') {
                  return (
                    <Combobox
                      {...p}
                      clearable={false}
                      value={(f.value as string) ?? null}
                      onChange={f.onChange}
                      options={field.options ?? []}
                    />
                  );
                }
                if (field.options?.length && name !== 'source' && name !== 'lifecycleStatus') {
                  return (
                    <Combobox
                      {...p}
                      clearable={false}
                      value={(f.value as string) ?? null}
                      onChange={f.onChange}
                      options={field.options}
                    />
                  );
                }
                return (
                  <ListSelect
                    {...p}
                    value={(f.value as string) ?? null}
                    onChange={f.onChange}
                    options={(field.options ?? []).map((o) => o.value)}
                  />
                );
              case 'money':
                return (
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 start-2.5 flex items-center text-xs text-muted">
                      {boot.settings.general.currency}
                    </span>
                    <Input
                      {...p}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      className="ps-12 tabular"
                      value={(f.value as number | string) ?? ''}
                      onChange={(e) => f.onChange(e.target.value === '' ? 0 : Number(e.target.value))}
                    />
                  </div>
                );
              case 'date':
                return (
                  <Input
                    {...p}
                    type="date"
                    value={(f.value as string) ?? ''}
                    onChange={(e) => f.onChange(e.target.value)}
                  />
                );
              default:
                return (
                  <Input
                    {...p}
                    type={
                      field.kind === 'email'
                        ? 'email'
                        : field.kind === 'phone'
                          ? 'tel'
                          : field.kind === 'url'
                            ? 'url'
                            : 'text'
                    }
                    value={(f.value as string) ?? ''}
                    onChange={(e) => f.onChange(e.target.value)}
                    onBlur={f.onBlur}
                  />
                );
            }
          }}
        </Field>
      )}
    />
  );
}

/** Stages of whichever pipeline the form has selected. */
function StageSelect({
  value,
  onChange,
  control,
  ...a11y
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  control: Control<Values>;
  id?: string;
  'aria-invalid'?: boolean;
}) {
  const boot = useBoot();
  const pipelineUuid = useWatch({ control, name: 'pipelineUuid' }) as string | null;
  const pipeline =
    boot.pipelines.find((x) => x.uuid === pipelineUuid) ??
    boot.pipelines.find((x) => x.entity === 'deal' && x.isDefault);
  const options = (pipeline?.stages ?? []).map((s) => ({ value: s.uuid, label: s.name }));
  const current = options.some((o) => o.value === value) ? value : (options[0]?.value ?? null);
  useEffect(() => {
    if (current !== value) onChange(current);
  }, [current, value, onChange]);
  return (
    <Combobox
      {...a11y}
      clearable={false}
      value={current}
      onChange={(v) => onChange(v as string)}
      options={options}
    />
  );
}

function applyFieldErrors(err: unknown, setError: UseFormSetError<Values>) {
  if (!(err instanceof ApiError)) return false;
  const fe = err.fieldErrors();
  for (const [path, message] of Object.entries(fe)) setError(path as keyof Values, { message });
  return Object.keys(fe).length > 0;
}

/** Only send what changed on edit (so read-only custom fields are never written back). */
function diffValues(before: Values, after: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (k === 'custom' || k.startsWith('_')) continue;
    if (JSON.stringify(v) !== JSON.stringify(before[k])) out[k] = v;
  }
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after.custom ?? {})) {
    if (JSON.stringify(v) !== JSON.stringify(before.custom?.[k])) custom[k] = v ?? null;
  }
  if (Object.keys(custom).length) out.custom = custom;
  return out;
}

export function RecordFormSheet<T extends { uuid: string }>({
  config,
  record,
  initial,
  open,
  onOpenChange,
  onSaved,
}: {
  config: EntityConfig;
  record?: T | null;
  initial?: Record<string, unknown>;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (rec: T) => void;
}) {
  const sections = useFormSections(config);
  const defaults = useMemo(
    () => ({ ...config.toForm(record as never), ...(initial ?? {}) }) as Values,
    [config, record, initial],
  );
  const form = useForm<Values>({ defaultValues: defaults });
  const { create, update } = useRecordMutations<T>(config.route);
  const navigate = useNavigate();
  const [labels, setLabels] = useState<Record<string, string | undefined>>({
    contactUuid: defaults._contactLabel as string | undefined,
    organizationUuid: defaults._organizationLabel as string | undefined,
  });

  useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  const watched = form.watch(['email', 'phone', 'firstName', 'lastName', 'name', 'website']);
  const dupes = useDuplicateCheck(config.entity, record ? null : watched);

  const submit = form.handleSubmit(async (values) => {
    const strip = (v: Values) => Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));
    try {
      const saved = record
        ? await update.mutateAsync({ uuid: record.uuid, input: diffValues(defaults, values) })
        : await create.mutateAsync(strip(values));
      toast.success(
        record ? 'Changes saved' : `${config.singular} created`,
        !record
          ? { action: { label: 'Open', onClick: () => navigate(`/${config.route}/${saved.uuid}`) } }
          : undefined,
      );
      onOpenChange(false);
      onSaved?.(saved);
    } catch (err) {
      if (!applyFieldErrors(err, form.setError))
        toast.error(err instanceof Error ? err.message : 'Could not save');
    }
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={record ? `Edit ${config.title(record as never)}` : `New ${config.singular}`}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={form.formState.isSubmitting}>
            {record ? 'Save changes' : `Create ${config.singular}`}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-6 p-5"
        noValidate
      >
        {dupes.length ? <DuplicateWarning route={config.route} dupes={dupes} /> : null}
        {sections.map((s) => (
          <fieldset key={s.key} className="flex flex-col gap-3">
            <legend className="mb-1 text-xs font-semibold text-muted">{s.label}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {s.fields.map((f) => (
                <div
                  key={f.key}
                  className={
                    f.kind === 'textarea' || f.def?.type === 'textarea' || f.kind === 'tags'
                      ? 'sm:col-span-2'
                      : ''
                  }
                >
                  <FieldInputControl
                    field={f}
                    control={form.control}
                    labels={labels}
                    setLabel={(k, v) => setLabels((l) => ({ ...l, [k]: v }))}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        ))}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

function useDuplicateCheck(entity: string, watched: unknown[] | null): DuplicateCandidate[] {
  const [debounced, setDebounced] = useState<unknown[] | null>(null);
  const key = JSON.stringify(watched);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(watched), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const enabled = !!debounced && (entity === 'contact' || entity === 'organization');
  const [email, phone, firstName, lastName, name, website] = (debounced ?? []) as (string | undefined)[];
  const q = useQuery({
    queryKey: ['duplicates', entity, debounced],
    queryFn: () =>
      entity === 'contact'
        ? apiPost<{ data: DuplicateCandidate[] }>('/contacts/check-duplicates', {
            email: email || null,
            phone: phone || null,
            firstName: firstName || null,
            lastName: lastName || null,
          })
        : apiPost<{ data: DuplicateCandidate[] }>('/organizations/check-duplicates', {
            name: name || null,
            website: website || null,
          }),
    enabled:
      enabled && !!(email || phone || name || website || ((firstName ?? '') + (lastName ?? '')).length >= 3),
    staleTime: 30_000,
  });
  return q.data?.data ?? [];
}

function DuplicateWarning({ route, dupes }: { route: string; dupes: DuplicateCandidate[] }) {
  return (
    <div role="status" className="rounded-sm border border-accent bg-accent-soft p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-accent">
        <AlertTriangle className="size-4" /> This might already exist
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {dupes.slice(0, 3).map((d) => (
          <li key={d.uuid} className="flex flex-wrap items-center gap-2">
            <a
              href={`${basePath}/${route}/${d.uuid}`}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-ink underline-offset-2 hover:underline"
            >
              {d.title}
            </a>
            {d.subtitle ? <span className="text-muted">{d.subtitle}</span> : null}
            <span className="text-xs text-muted">· {d.reasons.join(', ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
