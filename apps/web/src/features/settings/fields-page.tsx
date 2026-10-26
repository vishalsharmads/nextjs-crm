import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Archive, ArchiveRestore, GripVertical, Plus, Trash2 } from 'lucide-react';
import {
  CUSTOMIZABLE_ENTITIES,
  FIELD_KEY_RE,
  FIELD_TYPES,
  FILTERABLE_TYPES,
  type CustomFieldDef,
  type CustomizableEntity,
  type FieldOption,
  type FieldType,
  type VisibilityLevel,
} from '@app/shared';
import { ApiError, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { labelVars } from '@/lib/labels';
import { bootstrapKey, useBoot, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, Pane, Skeleton, Tabs, TabsList, TabsTrigger } from '@/components/ui/misc';
import { Sheet } from '@/components/ui/dialog';
import { Checkbox, Switch } from '@/components/ui/checkbox';
import { CustomFieldInput } from '@/components/fields/custom-field';
import { SettingsPage } from './layout';

const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Short text',
  textarea: 'Long text',
  number: 'Whole number',
  decimal: 'Decimal',
  currency: 'Money',
  date: 'Date',
  datetime: 'Date and time',
  boolean: 'Yes / no',
  select: 'Dropdown',
  multi_select: 'Multi-select',
  url: 'Link',
  email: 'Email',
  phone: 'Phone',
  user: 'User',
  file: 'File',
};

const keyFromLabel = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1')
    .slice(0, 49);

export function FieldsPage() {
  const t = useT();
  const boot = useBoot();
  const L = labelVars(boot.labels);
  const [entity, setEntity] = useState<CustomizableEntity>('contact');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<CustomFieldDef | 'new' | null>(null);
  const qc = useQueryClient();
  const fields = useQuery({
    queryKey: [...qk.customFields(entity), showArchived],
    queryFn: () =>
      apiGet<{ data: CustomFieldDef[] }>('/custom-fields', { entity, includeArchived: showArchived }).then(
        (r) => r.data,
      ),
  });
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => setOrder((fields.data ?? []).map((f) => f.uuid)), [fields.data]);
  const byUuid = useMemo(() => new Map((fields.data ?? []).map((f) => [f.uuid, f])), [fields.data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['custom-fields'] });
    void qc.invalidateQueries({ queryKey: bootstrapKey });
  };
  const reorder = useMutation({
    mutationFn: (uuids: string[]) => apiPut('/custom-fields/order', { entity, uuids }),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: ({ uuid, restore }: { uuid: string; restore?: boolean }) =>
      apiPost<CustomFieldDef>(`/custom-fields/${uuid}/${restore ? 'restore' : 'archive'}`),
    onSuccess: (f, v) => {
      toast.success(
        v.restore ? `${f.label} restored` : `${f.label} archived. Values are kept.`,
        v.restore
          ? undefined
          : { action: { label: 'Undo', onClick: () => archive.mutate({ uuid: f.uuid, restore: true }) } },
      );
      refresh();
    },
  });
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(order, order.indexOf(String(e.active.id)), order.indexOf(String(e.over.id)));
    setOrder(next);
    reorder.mutate(next.filter((u) => byUuid.get(u)?.active));
  };

  return (
    <SettingsPage
      title={t('settings.fields')}
      description="Capture what your industry needs. Fields appear in forms, record pages, list columns, filters, import and export."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> New field
        </Button>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={entity} onValueChange={(v) => setEntity(v as CustomizableEntity)}>
          <TabsList>
            {CUSTOMIZABLE_ENTITIES.filter((e) => e !== 'lead' || boot.settings.features.leads).map((e) => (
              <TabsTrigger key={e} value={e}>
                {L[`${e}Plural`]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <label className="flex items-center gap-2 text-sm text-muted">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} /> Show archived
        </label>
      </div>
      <Pane padded={false}>
        {fields.isPending ? (
          <Skeleton className="m-4 h-24" />
        ) : !fields.data?.length ? (
          <EmptyState
            title="No custom fields yet"
            description={`Add fields to capture details about ${L[`${entity}PluralLower`]}.`}
            action={<Button onClick={() => setEditing('new')}>Add a field</Button>}
          />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <ul className="divide-y divide-line">
                {order.map((uuid) => {
                  const f = byUuid.get(uuid);
                  return f ? (
                    <FieldRow
                      key={uuid}
                      field={f}
                      onEdit={() => setEditing(f)}
                      onArchive={() => archive.mutate({ uuid: f.uuid, restore: !f.active })}
                    />
                  ) : null;
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </Pane>
      {editing ? (
        <FieldEditor
          entity={entity}
          field={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </SettingsPage>
  );
}

function FieldRow({
  field,
  onEdit,
  onArchive,
}: {
  field: CustomFieldDef;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: field.uuid,
    disabled: !field.active,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-center gap-3 bg-surface px-3 py-2.5"
    >
      <button
        type="button"
        className="cursor-grab text-faint hover:text-ink disabled:invisible"
        aria-label={`Reorder ${field.label}`}
        disabled={!field.active}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-start">
        <span className="flex items-center gap-2">
          <span className={field.active ? 'font-medium' : 'font-medium text-muted line-through'}>
            {field.label}
          </span>
          {field.required ? <Badge tone="accent">Required</Badge> : null}
        </span>
        <span className="block font-mono text-2xs text-faint">cf.{field.key}</span>
      </button>
      <div className="hidden flex-wrap items-center justify-end gap-1 sm:flex">
        <Badge tone="outline">{TYPE_LABEL[field.type]}</Badge>
        {field.filterable ? <Badge>Filterable</Badge> : null}
        {field.showInList ? <Badge>In list</Badge> : null}
        {field.sourceBlueprint && !field.customized ? <Badge tone="primary">Blueprint</Badge> : null}
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onArchive}
        aria-label={field.active ? `Archive ${field.label}` : `Restore ${field.label}`}
      >
        {field.active ? <Archive /> : <ArchiveRestore />}
      </Button>
    </li>
  );
}

interface Draft {
  label: string;
  key: string;
  type: FieldType;
  group: string | null;
  options: FieldOption[];
  currency: string;
  helpText: string;
  required: boolean;
  filterable: boolean;
  showInList: boolean;
  defaultValue: unknown;
  visibility: { default: VisibilityLevel; roles: Record<string, VisibilityLevel> };
}

function FieldEditor({
  entity,
  field,
  onClose,
  onSaved,
}: {
  entity: CustomizableEntity;
  field: CustomFieldDef | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const boot = useBoot();
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () =>
      apiGet<{ data: { key: string; name: string; isSystem: boolean }[] }>('/roles').then((r) => r.data),
  });
  const groups = boot.fieldGroups.filter((g) => g.entity === entity);
  const [d, setD] = useState<Draft>(() => ({
    label: field?.label ?? '',
    key: field?.key ?? '',
    type: field?.type ?? 'text',
    group: field?.group ?? null,
    options: field?.options ?? [],
    currency: field?.currency ?? boot.settings.general.currency,
    helpText: field?.helpText ?? '',
    required: field?.required ?? false,
    filterable: field?.filterable ?? false,
    showInList: field?.showInList ?? false,
    defaultValue: field?.defaultValue ?? null,
    visibility: field?.visibility ?? { default: 'write', roles: {} },
  }));
  const [keyTouched, setKeyTouched] = useState(!!field);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState(0);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const isSelect = d.type === 'select' || d.type === 'multi_select';
  const canFilter = FILTERABLE_TYPES.includes(d.type);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        label: d.label,
        group: d.group,
        options: isSelect ? d.options : undefined,
        currency: d.type === 'currency' ? d.currency : undefined,
        helpText: d.helpText || null,
        required: d.required,
        filterable: canFilter && d.filterable,
        showInList: d.showInList,
        defaultValue: d.defaultValue,
        visibility: d.visibility,
      };
      return field
        ? apiPatch<CustomFieldDef & { missingCount: number }>(`/custom-fields/${field.uuid}`, payload)
        : apiPost<CustomFieldDef>('/custom-fields', { ...payload, entity, key: d.key, type: d.type });
    },
    onSuccess: (res) => {
      onSaved();
      const missingCount = (res as { missingCount?: number }).missingCount ?? 0;
      if (missingCount) {
        setMissing(missingCount);
        toast.warning(`${missingCount} existing records have no value for ${res.label} yet.`);
      } else toast.success(field ? 'Field saved' : 'Field created');
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
    },
  });

  const keyValid = FIELD_KEY_RE.test(d.key);
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={field ? `Edit ${field.label}` : 'New field'}
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!d.label.trim() || !keyValid || (isSelect && !d.options.length)}
          >
            {field ? 'Save field' : 'Create field'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 p-5">
        {missing ? (
          <p className="rounded-sm bg-accent-soft p-2 text-sm">{missing} records are missing a value.</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label" required error={errors.label}>
            {(p) => (
              <Input
                {...p}
                autoFocus
                value={d.label}
                onChange={(e) => {
                  set('label', e.target.value);
                  if (!keyTouched) set('key', keyFromLabel(e.target.value));
                }}
              />
            )}
          </Field>
          <Field
            label="Key"
            help={field ? 'Keys cannot change once created.' : 'Used in filters, imports and the API.'}
            error={!keyValid && d.key ? 'Lowercase letters, digits and underscores' : errors.key}
          >
            {(p) => (
              <Input
                {...p}
                value={d.key}
                disabled={!!field}
                onChange={(e) => {
                  setKeyTouched(true);
                  set('key', e.target.value);
                }}
                className="font-mono text-xs"
              />
            )}
          </Field>
          <Field label="Type" help={field ? 'Type cannot change once created.' : undefined}>
            {(p) => (
              <NativeSelect
                {...p}
                value={d.type}
                disabled={!!field}
                onChange={(e) => set('type', e.target.value as FieldType)}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Group">
            {(p) => (
              <NativeSelect
                {...p}
                value={d.group ?? ''}
                onChange={(e) => set('group', e.target.value || null)}
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          {d.type === 'currency' ? (
            <Field label="Currency">
              {(p) => (
                <Input
                  {...p}
                  maxLength={3}
                  value={d.currency}
                  onChange={(e) => set('currency', e.target.value.toUpperCase())}
                />
              )}
            </Field>
          ) : null}
        </div>

        {isSelect ? (
          <OptionsEditor
            options={d.options}
            onChange={(o) => set('options', o)}
            error={errors.options}
            locked={new Set(field?.options.map((o) => o.key) ?? [])}
          />
        ) : null}

        <Field label="Help text" help="Shown under the input.">
          {(p) => (
            <Textarea
              {...p}
              value={d.helpText}
              onChange={(e) => set('helpText', e.target.value)}
              className="min-h-14"
            />
          )}
        </Field>

        {d.type !== 'file' ? (
          <Field label="Default value" error={errors.defaultValue}>
            {(p) => (
              <CustomFieldInput
                {...p}
                def={{
                  uuid: '',
                  entity,
                  key: d.key || 'x',
                  label: d.label,
                  type: d.type,
                  group: null,
                  options: d.options,
                  currency: d.currency,
                  placeholder: null,
                  helpText: null,
                  required: false,
                  defaultValue: null,
                  validation: {},
                  visibility: d.visibility,
                  filterable: false,
                  showInList: false,
                  sortOrder: 0,
                  active: true,
                  sensitivity: 'normal',
                  sourceBlueprint: null,
                  customized: false,
                }}
                value={d.defaultValue}
                onChange={(v) => set('defaultValue', v)}
              />
            )}
          </Field>
        ) : null}

        <div className="flex flex-col gap-2.5 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>
              Required{' '}
              <span className="block text-xs text-muted">Must be filled in when creating a record.</span>
            </span>
            <Switch checked={d.required} onCheckedChange={(v) => set('required', v)} />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>
              Filterable and sortable{' '}
              <span className="block text-xs text-muted">
                {canFilter ? 'Adds a database index so lists stay fast.' : 'Not available for this type.'}
              </span>
            </span>
            <Switch
              checked={canFilter && d.filterable}
              onCheckedChange={(v) => set('filterable', v)}
              disabled={!canFilter}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>Show as a list column by default</span>
            <Switch checked={d.showInList} onCheckedChange={(v) => set('showInList', v)} />
          </label>
        </div>

        <section>
          <h3 className="mb-1 text-sm font-semibold">Who can see it</h3>
          <p className="mb-2 text-xs text-muted">
            Admins always have full access. Hidden fields are removed from every screen, export and API
            response for that role.
          </p>
          <div className="flex flex-col gap-1.5">
            <VisibilityRow
              label="Everyone (default)"
              value={d.visibility.default}
              onChange={(v) => set('visibility', { ...d.visibility, default: v })}
            />
            {roles.data
              ?.filter((r) => !r.isSystem)
              .map((r) => (
                <VisibilityRow
                  key={r.key}
                  label={r.name}
                  value={d.visibility.roles[r.key] ?? null}
                  inherit={d.visibility.default}
                  onChange={(v) => {
                    const rolesMap = Object.fromEntries(
                      Object.entries(d.visibility.roles).filter(([k]) => k !== r.key),
                    );
                    if (v !== null) rolesMap[r.key] = v;
                    set('visibility', { ...d.visibility, roles: rolesMap });
                  }}
                />
              ))}
          </div>
        </section>
      </div>
    </Sheet>
  );
}

function VisibilityRow<V extends VisibilityLevel | null>({
  label,
  value,
  inherit,
  onChange,
}: {
  label: string;
  value: V;
  inherit?: VisibilityLevel;
  onChange: (v: V) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="truncate">{label}</span>
      <NativeSelect
        aria-label={`Visibility for ${label}`}
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value || null) as V)}
        className="h-7 w-40 text-xs"
      >
        {inherit ? <option value="">Same as default ({inherit})</option> : null}
        <option value="write">Can edit</option>
        <option value="read">Read only</option>
        <option value="hidden">Hidden</option>
      </NativeSelect>
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
  error,
  locked,
}: {
  options: FieldOption[];
  onChange: (o: FieldOption[]) => void;
  error?: string;
  locked: Set<string>;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const label = draft.trim();
    if (!label) return;
    let key = keyFromLabel(label) || `option_${options.length + 1}`;
    while (options.some((o) => o.key === key)) key = `${key}_2`;
    onChange([...options, { key, label, active: true }]);
    setDraft('');
  };
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-muted">Options</legend>
      {error ? <p className="mb-1 text-xs text-accent">{error}</p> : null}
      <ul className="flex flex-col gap-1">
        {options.map((o, i) => (
          <li key={o.key} className="flex items-center gap-2">
            <Input
              aria-label="Option label"
              value={o.label}
              onChange={(e) =>
                onChange(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
              }
              className={o.active === false ? 'line-through' : ''}
            />
            {locked.has(o.key) ? (
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                <Checkbox
                  checked={o.active !== false}
                  onCheckedChange={(v) =>
                    onChange(options.map((x, j) => (j === i ? { ...x, active: v } : x)))
                  }
                  aria-label={`${o.label} active`}
                />
                Active
              </label>
            ) : (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${o.label}`}
                onClick={() => onChange(options.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add an option and press Enter"
        />
        <Button onClick={add}>Add</Button>
      </div>
      {locked.size ? (
        <p className="mt-1.5 text-xs text-muted">
          Existing options can be deactivated but not removed, so stored values stay readable.
        </p>
      ) : null}
    </fieldset>
  );
}
