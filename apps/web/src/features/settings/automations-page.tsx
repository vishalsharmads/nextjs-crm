import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Trash2, Workflow } from 'lucide-react';
import type { CoreEntity, FilterCondition, FilterNode } from '@app/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useBoot, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { Sheet } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/checkbox';
import { Combobox } from '@/components/fields/combobox';
import { TagsInput, UserPicker } from '@/components/fields/pickers';
import { FilterBar } from '@/components/data/filter-bar';
import { buildConfig } from '@/features/records/entities';
import { labelVars } from '@/lib/labels';
import { SettingsPage } from './layout';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { useMergeFields } from '@/components/editor/use-templates';

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
  | { type: 'add_tags'; tags: string[] }
  | { type: 'remove_tags'; tags: string[] }
  | { type: 'assign'; users: string[] }
  | { type: 'add_note'; body: string };

interface Schedule {
  entity: string;
  frequency: 'daily' | 'weekly';
  weekday: number;
  time: string;
}

interface AutomationRow {
  uuid: string;
  name: string;
  description: string;
  triggerEvent: string;
  conditions: FilterNode | null;
  actions: Action[];
  delayMinutes: number;
  schedule: Schedule | null;
  nextRunAt: string | null;
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
    sent: 'is sent',
    accepted: 'is accepted',
    declined: 'is declined',
    issued: 'is issued',
    paid: 'is paid in full',
    overdue: 'becomes overdue',
    voided: 'is voided',
    recorded: 'is recorded',
    activated: 'becomes active',
    renewal_due: 'is due for renewal',
    renewed: 'is renewed',
    expired: 'expires',
    cancelled: 'is cancelled',
    replied: 'gets a reply',
    resolved: 'is resolved',
    shared: 'is shared',
    signed: 'is signed',
    reviewed: 'is reviewed',
    assigned: 'is lent out',
    returned: 'is returned',
    low: 'runs low',
  };
  return (event: string) => {
    if (event === 'schedule') return 'On a schedule';
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
  remove_tags: 'Remove tags',
  assign: 'Assign in turn',
  add_note: 'Add a note',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DELAY_UNITS = [
  { value: 1, label: 'minutes' },
  { value: 60, label: 'hours' },
  { value: 1440, label: 'days' },
];

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
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
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
  const [schedule, setSchedule] = useState<Schedule>(
    automation?.schedule ?? { entity: 'deal', frequency: 'daily', weekday: 1, time: '09:00' },
  );
  const initialDelay = automation?.delayMinutes ?? 0;
  const initialUnit = [1440, 60, 1].find((u) => initialDelay % u === 0 && initialDelay >= u) ?? 60;
  const [delayUnit, setDelayUnit] = useState(initialUnit);
  const [delayAmount, setDelayAmount] = useState(initialDelay ? initialDelay / initialUnit : 0);
  const scheduled = trigger === 'schedule';
  const entity = (scheduled ? schedule.entity : trigger.split('.')[0]) as CoreEntity | 'form';
  const scheduleEntities = [
    ...['contact', 'organization', 'lead', 'deal', 'activity'],
    ...boot.recordTypes.map((t) => t.entity),
  ];
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
        schedule: scheduled ? schedule : null,
        delayMinutes: scheduled ? 0 : Math.max(0, Math.round(delayAmount * delayUnit)),
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
          {scheduled ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              For each
              <NativeSelect
                aria-label="Record type"
                value={schedule.entity}
                onChange={(e) => (setSchedule({ ...schedule, entity: e.target.value }), setConditions([]))}
                className="h-8 w-40"
              >
                {scheduleEntities.map((e) => (
                  <option key={e} value={e}>
                    {boot.labels[e]?.singular ?? e}
                  </option>
                ))}
              </NativeSelect>
              that matches, run
              <NativeSelect
                aria-label="Frequency"
                value={schedule.frequency}
                onChange={(e) =>
                  setSchedule({ ...schedule, frequency: e.target.value as Schedule['frequency'] })
                }
                className="h-8 w-28"
              >
                <option value="daily">every day</option>
                <option value="weekly">every week</option>
              </NativeSelect>
              {schedule.frequency === 'weekly' ? (
                <NativeSelect
                  aria-label="Day"
                  value={schedule.weekday}
                  onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}
                  className="h-8 w-32"
                >
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      on {d}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
              at
              <Input
                aria-label="Time"
                type="time"
                value={schedule.time}
                onChange={(e) => setSchedule({ ...schedule, time: e.target.value })}
                className="h-8 w-28"
              />
              <span className="text-xs text-muted">({boot.settings.general.timezone})</span>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              Wait
              <Input
                aria-label="Delay"
                type="number"
                min={0}
                value={delayAmount}
                onChange={(e) => setDelayAmount(Math.max(0, Number(e.target.value)))}
                className="h-8 w-20"
              />
              <NativeSelect
                aria-label="Delay unit"
                value={delayUnit}
                onChange={(e) => setDelayUnit(Number(e.target.value))}
                className="h-8 w-28"
              >
                {DELAY_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </NativeSelect>
              <span className="text-xs text-muted">
                {delayAmount > 0 ? 'then check the conditions again before acting' : 'act straight away'}
              </span>
            </div>
          )}
        </section>
        {config ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold">Only if</h3>
            <FilterBar
              fields={!scheduled && trigger.endsWith('.updated') ? [changedField, ...fields] : fields}
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
                entity={entity}
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
    case 'remove_tags':
      return { type, tags: [] };
    case 'assign':
      return { type, users: [] };
    case 'add_note':
      return { type, body: 'Checked in on {{record.title}}' };
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
  entity,
  onChange,
  fieldOptions,
}: {
  action: Action;
  entity: CoreEntity | 'form';
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
          <EmailBody entity={entity} value={action.body} onChange={(body) => onChange({ ...action, body })} />
        </div>
      );
    case 'add_tags':
    case 'remove_tags':
      return <TagsInput value={action.tags} onChange={(tags) => onChange({ ...action, tags })} />;
    case 'assign':
      return (
        <div className="flex flex-col gap-2">
          {action.users.map((u, i) => (
            <div key={`${u}-${i}`} className="flex items-center gap-2">
              <div className="flex-1">
                <UserPicker
                  value={u}
                  onChange={(v) =>
                    onChange({
                      ...action,
                      users: action.users.map((x, j) => (j === i ? (v ?? '') : x)).filter(Boolean),
                    })
                  }
                />
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Remove person"
                onClick={() => onChange({ ...action, users: action.users.filter((_, j) => j !== i) })}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <UserPicker
            value={null}
            onChange={(v) => v && onChange({ ...action, users: [...action.users, v] })}
          />
          <p className="text-xs text-muted">Each run assigns the next person in the list.</p>
        </div>
      );
    case 'add_note':
      return (
        <RichTextEditor
          aria-label="Note"
          mode="basic"
          value={action.body}
          onChange={(body) => onChange({ ...action, body })}
          className="min-h-24"
        />
      );
  }
}

/** The automation renders `{{record.*}}` from the record that triggered it. */
function EmailBody({
  entity,
  value,
  onChange,
}: {
  entity: CoreEntity | 'form';
  value: string;
  onChange: (html: string) => void;
}) {
  const groups = useMergeFields();
  const mergeFields = useMemo(() => {
    const group = groups?.find((g) => g.key === entity);
    return group
      ? [
          {
            ...group,
            fields: group.fields.map((f) => ({ ...f, path: f.path.replace(/^[a-z]+\./, 'record.') })),
          },
        ]
      : undefined;
  }, [groups, entity]);
  return (
    <RichTextEditor
      aria-label="Body"
      value={value}
      onChange={onChange}
      mergeFields={mergeFields}
      className="min-h-32"
    />
  );
}

// ---------------- Web forms ----------------
