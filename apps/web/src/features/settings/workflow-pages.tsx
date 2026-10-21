import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Copy, ExternalLink, Plus, Trash2, Workflow, FileInput } from 'lucide-react';
import type { CoreEntity, FilterCondition, FilterNode } from '@app/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useBoot, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, Pane, Skeleton } from '@/components/ui/misc';
import { Sheet } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/checkbox';
import { Combobox } from '@/components/fields/combobox';
import { TagsInput, UserPicker } from '@/components/fields/pickers';
import { FilterBar } from '@/components/data/filter-bar';
import { buildConfig } from '@/features/records/entities';
import { labelVars } from '@/lib/labels';
import { SettingsPage } from './layout';

// ---------------- Automations ----------------

type Action =
  | { type: 'update_field'; field: string; value: unknown }
  | {
      type: 'create_task';
      subject: string;
      dueInDays: number;
      assignee: string;
      priority: 'low' | 'normal' | 'high';
    }
  | { type: 'notify'; to: string; title: string; body?: string }
  | { type: 'send_email'; to: string; subject: string; body: string }
  | { type: 'add_tags'; tags: string[] };

interface AutomationRow {
  uuid: string;
  name: string;
  description: string;
  triggerEvent: string;
  conditions: FilterNode | null;
  actions: Action[];
  active: boolean;
  runCount: number;
  lastRunAt: string | null;
}

/** Human wording for event keys, using the workspace vocabulary. */
function useEventLabel() {
  const boot = useBoot();
  const L = labelVars(boot.labels);
  const verbs: Record<string, string> = {
    created: 'is created',
    updated: 'is updated',
    deleted: 'is deleted',
    stage_changed: 'changes stage',
    won: 'is won',
    lost: 'is lost',
    completed: 'is completed',
    converted: 'is converted',
    submitted: 'is submitted',
  };
  return (event: string) => {
    const [entity, action] = event.split('.') as [string, string];
    const noun = entity === 'form' ? 'Web form' : (L[entity] ?? entity);
    return `${noun} ${verbs[action] ?? action}`;
  };
}

const ACTION_LABEL: Record<Action['type'], string> = {
  update_field: 'Update a field',
  create_task: 'Create a task',
  notify: 'Send an in-app notification',
  send_email: 'Send an email',
  add_tags: 'Add tags',
};

export function AutomationsPage() {
  const t = useT();
  const qc = useQueryClient();
  const eventLabel = useEventLabel();
  const list = useQuery({
    queryKey: ['automations'],
    queryFn: () => apiGet<{ data: AutomationRow[]; events: string[] }>('/automations'),
  });
  const [editing, setEditing] = useState<AutomationRow | 'new' | null>(null);
  const toggle = useMutation({
    mutationFn: (a: AutomationRow) => apiPatch(`/automations/${a.uuid}`, { active: !a.active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['automations'] }),
  });
  return (
    <SettingsPage
      title={t('settings.automations')}
      description="When something happens, check conditions and take actions automatically: follow-up tasks, notifications, emails, field updates."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> New automation
        </Button>
      }
    >
      <Pane padded={false}>
        {list.isPending ? (
          <Skeleton className="m-4 h-20" />
        ) : !list.data?.data.length ? (
          <EmptyState
            icon={<Workflow />}
            title="No automations yet"
            description="Start with a follow-up task whenever a new record is created."
            action={<Button onClick={() => setEditing('new')}>Create one</Button>}
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.data.map((a) => (
              <li key={a.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <button type="button" onClick={() => setEditing(a)} className="min-w-0 flex-1 text-start">
                  <p className="font-medium hover:underline">{a.name}</p>
                  <p className="truncate text-xs text-muted">
                    When {eventLabel(a.triggerEvent).toLowerCase()} →{' '}
                    {a.actions.map((x) => ACTION_LABEL[x.type].toLowerCase()).join(', ')}
                  </p>
                </button>
                <span className="text-xs text-faint">
                  {a.runCount} runs{a.lastRunAt ? ` · ${formatRelative(a.lastRunAt)}` : ''}
                </span>
                <Switch
                  checked={a.active}
                  onCheckedChange={() => toggle.mutate(a)}
                  aria-label={`${a.name} active`}
                />
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {editing ? (
        <AutomationEditor
          automation={editing === 'new' ? null : editing}
          events={list.data?.events ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['automations'] })}
        />
      ) : null}
    </SettingsPage>
  );
}

function flatConditions(node: FilterNode | null): FilterCondition[] {
  if (!node) return [];
  if ('and' in node) return node.and.filter((n): n is FilterCondition => 'field' in n);
  if ('field' in node) return [node];
  return [];
}

function AutomationEditor({
  automation,
  events,
  onClose,
  onSaved,
}: {
  automation: AutomationRow | null;
  events: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const boot = useBoot();
  const eventLabel = useEventLabel();
  const [name, setName] = useState(automation?.name ?? '');
  const [trigger, setTrigger] = useState(automation?.triggerEvent ?? 'deal.created');
  const [conditions, setConditions] = useState<FilterCondition[]>(
    flatConditions(automation?.conditions ?? null),
  );
  const [actions, setActions] = useState<Action[]>(
    automation?.actions ?? [
      {
        type: 'create_task',
        subject: 'Follow up on {{record.title}}',
        dueInDays: 1,
        assignee: 'owner',
        priority: 'normal',
      },
    ],
  );
  const entity = trigger.split('.')[0] as CoreEntity | 'form';
  const config = useMemo(() => (entity === 'form' ? null : buildConfig(entity, boot)), [entity, boot]);
  const runs = useQuery({
    queryKey: ['automations', automation?.uuid, 'runs'],
    queryFn: () =>
      apiGet<{ data: { event: string; status: string; log: string[]; createdAt: string }[] }>(
        `/automations/${automation!.uuid}/runs`,
      ).then((r) => r.data),
    enabled: !!automation,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        triggerEvent: trigger,
        conditions: conditions.length ? { and: conditions } : null,
        actions,
      };
      return automation ? apiPatch(`/automations/${automation.uuid}`, body) : apiPost('/automations', body);
    },
    onSuccess: () => {
      toast.success('Automation saved');
      onSaved();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/automations/${automation!.uuid}`),
    onSuccess: () => (onSaved(), onClose()),
  });
  const setAction = (i: number, a: Action) => setActions(actions.map((x, j) => (j === i ? a : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...actions];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setActions(next);
  };
  const fields = config?.fields ?? [];
  const changedField = {
    key: 'changed',
    label: 'Changed fields',
    kind: 'select' as const,
    get: () => null,
    filterable: true,
    options: fields.filter((f) => f.filterable).map((f) => ({ value: f.key, label: f.label })),
  };
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={automation ? automation.name : 'New automation'}
      width="max-w-2xl"
      footer={
        <>
          {automation ? (
            <Button variant="ghost" className="me-auto text-accent" onClick={() => remove.mutate()}>
              <Trash2 /> Delete
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!name.trim() || !actions.length}
          >
            Save automation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 p-5">
        <Field label="Name">
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Welcome new members"
            />
          )}
        </Field>
        <section>
          <h3 className="mb-2 text-sm font-semibold">When</h3>
          <Combobox
            clearable={false}
            value={trigger}
            onChange={(v) => (setTrigger(v as string), setConditions([]))}
            options={events.map((e) => ({ value: e, label: eventLabel(e) }))}
          />
        </section>
        {config ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold">Only if</h3>
            <FilterBar
              fields={trigger.endsWith('.updated') ? [changedField, ...fields] : fields}
              conditions={conditions}
              onChange={setConditions}
            />
            {!conditions.length ? (
              <p className="mt-1 text-xs text-muted">No conditions: runs every time.</p>
            ) : null}
          </section>
        ) : null}
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Then</h3>
          {actions.map((a, i) => (
            <div key={i} className="rounded-md border border-line p-3">
              <div className="mb-2 flex items-center gap-2">
                <NativeSelect
                  aria-label="Action"
                  value={a.type}
                  onChange={(e) => setAction(i, defaultAction(e.target.value as Action['type']))}
                  className="h-7 flex-1 text-xs"
                >
                  {Object.entries(ACTION_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </NativeSelect>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label="Move up"
                >
                  <ArrowUp />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={i === actions.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  <ArrowDown />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setActions(actions.filter((_, j) => j !== i))}
                  aria-label="Remove action"
                >
                  <Trash2 />
                </Button>
              </div>
              <ActionEditor
                action={a}
                onChange={(x) => setAction(i, x)}
                fieldOptions={fields
                  .filter((f) => f.input || f.def)
                  .map((f) => ({ value: f.def ? `cf.${f.def.key}` : f.input!, label: f.label }))}
              />
            </div>
          ))}
          <Button size="sm" onClick={() => setActions([...actions, defaultAction('notify')])}>
            <Plus /> Add action
          </Button>
          <p className="text-xs text-muted">
            Text can use the record: {'{{record.title}}'}, {'{{record.fullName}}'}, {'{{record.owner.name}}'}.
          </p>
        </section>
        {automation && runs.data?.length ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold">Recent runs</h3>
            <ul className="divide-y divide-line rounded-md border border-line text-xs">
              {runs.data.map((r, i) => (
                <li key={i} className="flex items-center gap-2 px-3 py-2">
                  <Badge
                    tone={r.status === 'succeeded' ? 'primary' : r.status === 'failed' ? 'accent' : 'outline'}
                  >
                    {r.status}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate">{r.log.join(' · ')}</span>
                  <span className="text-faint">{formatDateTime(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}

function defaultAction(type: Action['type']): Action {
  switch (type) {
    case 'update_field':
      return { type, field: '', value: '' };
    case 'create_task':
      return {
        type,
        subject: 'Follow up on {{record.title}}',
        dueInDays: 1,
        assignee: 'owner',
        priority: 'normal',
      };
    case 'notify':
      return { type, to: 'owner', title: 'Heads up: {{record.title}}' };
    case 'send_email':
      return {
        type,
        to: 'record',
        subject: 'Hello {{record.firstName}}',
        body: '<p>Thanks for getting in touch.</p>',
      };
    case 'add_tags':
      return { type, tags: [] };
  }
}

function Recipient({
  value,
  onChange,
  allowRecord,
}: {
  value: string;
  onChange: (v: string) => void;
  allowRecord?: boolean;
}) {
  const preset = ['owner', 'actor', 'record'].includes(value);
  return (
    <div className="flex flex-wrap gap-2">
      <NativeSelect
        aria-label="Recipient"
        value={preset ? value : 'user'}
        onChange={(e) => onChange(e.target.value === 'user' ? '' : e.target.value)}
        className="h-8 w-48 text-xs"
      >
        <option value="owner">The record’s owner</option>
        <option value="actor">Whoever made the change</option>
        {allowRecord ? <option value="record">The record’s email address</option> : null}
        <option value="user">A specific person</option>
      </NativeSelect>
      {!preset ? (
        <div className="min-w-48 flex-1">
          <UserPicker value={value || null} onChange={(v) => onChange(v ?? '')} />
        </div>
      ) : null}
    </div>
  );
}

function ActionEditor({
  action,
  onChange,
  fieldOptions,
}: {
  action: Action;
  onChange: (a: Action) => void;
  fieldOptions: { value: string; label: string }[];
}) {
  switch (action.type) {
    case 'update_field':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Combobox
            value={action.field || null}
            onChange={(v) => onChange({ ...action, field: (v as string) ?? '' })}
            options={fieldOptions}
            placeholder="Field"
          />
          <Input
            aria-label="Value"
            value={String(action.value ?? '')}
            onChange={(e) => onChange({ ...action, value: e.target.value })}
            placeholder="New value"
          />
        </div>
      );
    case 'create_task':
      return (
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Task subject"
            value={action.subject}
            onChange={(e) => onChange({ ...action, subject: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            Due in
            <Input
              aria-label="Due in days"
              type="number"
              min={0}
              value={action.dueInDays}
              onChange={(e) => onChange({ ...action, dueInDays: Number(e.target.value) })}
              className="h-7 w-16"
            />
            days, assigned to
            <Recipient value={action.assignee} onChange={(v) => onChange({ ...action, assignee: v })} />
          </div>
        </div>
      );
    case 'notify':
      return (
        <div className="flex flex-col gap-2">
          <Recipient value={action.to} onChange={(v) => onChange({ ...action, to: v })} />
          <Input
            aria-label="Title"
            value={action.title}
            onChange={(e) => onChange({ ...action, title: e.target.value })}
          />
        </div>
      );
    case 'send_email':
      return (
        <div className="flex flex-col gap-2">
          <Recipient value={action.to} onChange={(v) => onChange({ ...action, to: v })} allowRecord />
          <Input
            aria-label="Subject"
            value={action.subject}
            onChange={(e) => onChange({ ...action, subject: e.target.value })}
          />
          <Textarea
            aria-label="Body"
            value={action.body}
            onChange={(e) => onChange({ ...action, body: e.target.value })}
            className="font-mono text-xs"
          />
        </div>
      );
    case 'add_tags':
      return <TagsInput value={action.tags} onChange={(tags) => onChange({ ...action, tags })} />;
  }
}

// ---------------- Web forms ----------------

interface FormField {
  target: string;
  label: string;
  required: boolean;
  placeholder?: string;
}
interface FormRow {
  uuid: string;
  name: string;
  entity: 'contact' | 'lead';
  fields: FormField[];
  settings: Record<string, unknown> & {
    tags?: string[];
    successMessage?: string;
    redirectUrl?: string;
    title?: string;
    intro?: string;
    ownerUuid?: string | null;
    notifyOwner?: boolean;
    source?: string;
    consentText?: string;
    submitLabel?: string;
  };
  active: boolean;
  submissionCount: number;
}

const CORE_FORM_FIELDS: Record<'contact' | 'lead', { target: string; label: string }[]> = {
  contact: [
    { target: 'firstName', label: 'First name' },
    { target: 'lastName', label: 'Last name' },
    { target: 'email', label: 'Email' },
    { target: 'phone', label: 'Phone' },
    { target: 'jobTitle', label: 'Job title' },
  ],
  lead: [
    { target: 'firstName', label: 'First name' },
    { target: 'lastName', label: 'Last name' },
    { target: 'email', label: 'Email' },
    { target: 'phone', label: 'Phone' },
    { target: 'companyName', label: 'Company' },
    { target: 'jobTitle', label: 'Job title' },
  ],
};

export function FormsPage() {
  const t = useT();
  const qc = useQueryClient();
  const forms = useQuery({
    queryKey: ['web-forms'],
    queryFn: () => apiGet<{ data: FormRow[] }>('/forms').then((r) => r.data),
  });
  const [editing, setEditing] = useState<FormRow | 'new' | null>(null);
  return (
    <SettingsPage
      title={t('settings.forms')}
      description="Put a form on your website. Submissions arrive as new records, tagged and assigned, and can trigger automations."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> New form
        </Button>
      }
    >
      <Pane padded={false}>
        {forms.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : !forms.data?.length ? (
          <EmptyState
            icon={<FileInput />}
            title="No forms yet"
            description="Create an enquiry form for your website in a minute."
          />
        ) : (
          <ul className="divide-y divide-line">
            {forms.data.map((f) => (
              <li key={f.uuid}>
                <button
                  type="button"
                  onClick={() => setEditing(f)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start text-sm hover:bg-hover"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{f.name}</p>
                    <p className="text-xs text-muted">
                      {f.submissionCount} submissions · {f.fields.length} fields
                    </p>
                  </div>
                  {f.active ? <Badge tone="primary">Live</Badge> : <Badge>Off</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {editing ? (
        <FormEditor
          form={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['web-forms'] })}
        />
      ) : null}
    </SettingsPage>
  );
}

function FormEditor({
  form,
  onClose,
  onSaved,
}: {
  form: FormRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const boot = useBoot();
  const L = labelVars(boot.labels);
  const [name, setName] = useState(form?.name ?? '');
  const [entity, setEntity] = useState<'contact' | 'lead'>(
    form?.entity ?? (boot.settings.features.leads ? 'lead' : 'contact'),
  );
  const [fields, setFields] = useState<FormField[]>(
    form?.fields ?? [
      { target: 'firstName', label: 'First name', required: true },
      { target: 'email', label: 'Email', required: true },
    ],
  );
  const [settings, setSettings] = useState<FormRow['settings']>(
    form?.settings ?? {
      successMessage: 'Thanks, we will be in touch soon.',
      tags: [],
      notifyOwner: true,
      source: 'Web form',
      submitLabel: 'Send',
    },
  );
  const [active, setActive] = useState(form?.active ?? true);
  const available = [
    ...CORE_FORM_FIELDS[entity],
    ...boot.customFields
      .filter((c) => c.entity === entity && c.type !== 'file' && c.type !== 'user')
      .map((c) => ({ target: `cf.${c.key}`, label: c.label })),
  ].filter((a) => !fields.some((f) => f.target === a.target));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        entity,
        fields,
        settings: { ...settings, ownerUuid: settings.ownerUuid || null },
        active,
      };
      return form ? apiPatch(`/forms/${form.uuid}`, body) : apiPost('/forms', body);
    },
    onSuccess: () => {
      toast.success('Form saved');
      onSaved();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/forms/${form!.uuid}`),
    onSuccess: () => (onSaved(), onClose()),
  });
  const publicUrl = form ? `${window.location.origin}/f/${form.uuid}` : null;
  const embed = publicUrl
    ? `<iframe src="${publicUrl}?embed=1" style="width:100%;min-height:560px;border:0" title="${name}"></iframe>`
    : '';
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={form ? form.name : 'New form'}
      width="max-w-2xl"
      footer={
        <>
          {form ? (
            <Button variant="ghost" className="me-auto text-accent" onClick={() => remove.mutate()}>
              <Trash2 /> Delete
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!name.trim() || !fields.length}
          >
            Save form
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Creates">
            {(p) => (
              <NativeSelect
                {...p}
                value={entity}
                disabled={!!form}
                onChange={(e) => (
                  setEntity(e.target.value as 'contact' | 'lead'),
                  setFields(fields.filter((f) => !f.target.startsWith('cf.')))
                )}
              >
                {boot.settings.features.leads ? <option value="lead">{L.lead}</option> : null}
                <option value="contact">{L.contact}</option>
              </NativeSelect>
            )}
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
            Accepting submissions <Switch checked={active} onCheckedChange={setActive} />
          </label>
        </div>
        <section>
          <h3 className="mb-2 text-sm font-semibold">Fields</h3>
          <ul className="flex flex-col gap-2">
            {fields.map((f, i) => (
              <li key={f.target} className="flex items-center gap-2">
                <Input
                  aria-label="Field label"
                  value={f.label}
                  onChange={(e) =>
                    setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                  }
                  className="flex-1"
                />
                <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) =>
                      setFields(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))
                    }
                  />{' '}
                  Required
                </label>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${f.label}`}
                  onClick={() => setFields(fields.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
          {available.length ? (
            <div className="mt-2 w-64">
              <Combobox
                value={null}
                onChange={(v) =>
                  v &&
                  setFields([
                    ...fields,
                    {
                      target: v as string,
                      label: available.find((a) => a.target === v)!.label,
                      required: false,
                    },
                  ])
                }
                options={available.map((a) => ({ value: a.target, label: a.label }))}
                placeholder="Add a field"
              />
            </div>
          ) : null}
        </section>
        <section className="grid gap-3 sm:grid-cols-2">
          <h3 className="text-sm font-semibold sm:col-span-2">After someone submits</h3>
          <Field label="Assign to" className="sm:col-span-2">
            {(p) => (
              <UserPicker
                {...p}
                value={settings.ownerUuid ?? null}
                onChange={(v) => setSettings({ ...settings, ownerUuid: v })}
                placeholder="Me"
              />
            )}
          </Field>
          <Field label="Tags">
            {(p) => (
              <TagsInput
                {...p}
                value={settings.tags ?? []}
                onChange={(tags) => setSettings({ ...settings, tags })}
              />
            )}
          </Field>
          <Field label="Source">
            {(p) => (
              <Input
                {...p}
                value={settings.source ?? ''}
                onChange={(e) => setSettings({ ...settings, source: e.target.value })}
              />
            )}
          </Field>
          <Field label="Thank-you message" className="sm:col-span-2">
            {(p) => (
              <Textarea
                {...p}
                value={settings.successMessage ?? ''}
                onChange={(e) => setSettings({ ...settings, successMessage: e.target.value })}
                className="min-h-14"
              />
            )}
          </Field>
          <Field label="Redirect to (optional)" className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                type="url"
                value={settings.redirectUrl ?? ''}
                onChange={(e) => setSettings({ ...settings, redirectUrl: e.target.value })}
                placeholder="https://"
              />
            )}
          </Field>
          <Field
            label="Consent text (optional)"
            className="sm:col-span-2"
            help="Shown above the button, e.g. how you will use their data."
          >
            {(p) => (
              <Textarea
                {...p}
                value={settings.consentText ?? ''}
                onChange={(e) => setSettings({ ...settings, consentText: e.target.value })}
                className="min-h-14"
              />
            )}
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
            Notify the assignee{' '}
            <Switch
              checked={settings.notifyOwner !== false}
              onCheckedChange={(v) => setSettings({ ...settings, notifyOwner: v })}
            />
          </label>
        </section>
        {publicUrl ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Share or embed</h3>
            <div className="flex gap-2">
              <Input readOnly value={publicUrl} aria-label="Form link" className="text-xs" />
              <Button asChild>
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open
                </a>
              </Button>
            </div>
            <div className="flex gap-2">
              <Textarea
                readOnly
                value={embed}
                aria-label="Embed code"
                className="min-h-16 font-mono text-xs"
              />
              <Button
                onClick={() => void navigator.clipboard?.writeText(embed).then(() => toast.success('Copied'))}
                aria-label="Copy embed code"
              >
                <Copy />
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
