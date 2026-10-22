import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LifeBuoy, Lock, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { cn } from '@/lib/cn';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, Pane, Skeleton } from '@/components/ui/misc';
import { RecordPicker, UserPicker } from '@/components/fields/pickers';

type Status = 'open' | 'pending' | 'resolved' | 'closed';
type Priority = 'low' | 'normal' | 'high' | 'urgent';
interface Ref {
  uuid: string;
  name: string;
}
interface Ticket {
  uuid: string;
  number: string;
  subject: string;
  description: string | null;
  status: Status;
  priority: Priority;
  category: string;
  channel: string;
  contact: Ref | null;
  organization: Ref | null;
  assignee: Ref | null;
  createdBy: Ref | null;
  firstResponseDueAt: string | null;
  resolveDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  responseOverdue: boolean;
  resolutionOverdue: boolean;
  lastActivityAt: string;
  createdAt: string;
  comments?: {
    uuid: string;
    body: string;
    internal: boolean;
    fromCustomer: boolean;
    author: { name: string } | null;
    createdAt: string;
  }[];
}

const BASE = '/m/tickets/tickets';
const ROOT = '/m/tickets';
const KEY = ['m', 'tickets'] as const;
const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  pending: 'Waiting on customer',
  resolved: 'Resolved',
  closed: 'Closed',
};
const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

function useNouns() {
  const L = labelVars(useBoot().labels);
  return { one: L.ticket ?? 'Ticket', many: L.ticketPlural ?? 'Tickets' };
}

function PriorityBadge({ p }: { p: Priority }) {
  return (
    <Badge tone={p === 'urgent' ? 'accent' : p === 'high' ? 'outline' : 'neutral'}>{PRIORITY_LABEL[p]}</Badge>
  );
}

const TABS: { key: string; label: string; query: Record<string, string> }[] = [
  { key: 'active', label: 'Active', query: { status: 'active' } },
  { key: 'mine', label: 'Mine', query: { status: 'active', assignee: '@me' } },
  { key: 'unassigned', label: 'Unassigned', query: { status: 'active', assignee: 'none' } },
  { key: 'overdue', label: 'Overdue', query: { overdue: 'true' } },
  { key: 'resolved', label: 'Resolved', query: { status: 'resolved' } },
  { key: 'closed', label: 'Closed', query: { status: 'closed' } },
];

function NewTicketDialog({ onDone }: { onDone: (uuid?: string) => void }) {
  const L = labelVars(useBoot().labels);
  const nouns = useNouns();
  const qc = useQueryClient();
  const [v, setV] = useState({
    subject: '',
    description: '',
    priority: 'normal' as Priority,
    category: '',
    channel: 'staff',
    contact: null as Ref | null,
    assignee: '@me' as string | null,
  });
  const create = useMutation({
    mutationFn: () =>
      apiPost<Ticket>(BASE, {
        subject: v.subject,
        description: v.description || null,
        priority: v.priority,
        category: v.category,
        channel: v.channel,
        contactUuid: v.contact?.uuid ?? null,
        assigneeUuid: v.assignee,
      }),
    onSuccess: (t) => {
      toast.success(`${nouns.one} created`);
      void qc.invalidateQueries({ queryKey: KEY });
      onDone(t.uuid);
    },
  });
  const errors = create.error instanceof ApiError ? create.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={`New ${nouns.one.toLowerCase()}`}
        className="max-w-xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => onDone()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!v.subject.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Create {nouns.one.toLowerCase()}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Subject" required className="sm:col-span-2" error={errors.subject}>
            {(p) => (
              <Input
                {...p}
                value={v.subject}
                onChange={(e) => setV({ ...v, subject: e.target.value })}
                autoFocus
              />
            )}
          </Field>
          <Field label={L.contact}>
            {(p) => (
              <RecordPicker
                {...p}
                route="contacts"
                value={v.contact?.uuid ?? null}
                label={v.contact?.name}
                onChange={(uuid, name) => setV({ ...v, contact: uuid ? { uuid, name: name ?? '' } : null })}
              />
            )}
          </Field>
          <Field label="Assignee">
            {(p) => <UserPicker {...p} value={v.assignee} onChange={(u) => setV({ ...v, assignee: u })} />}
          </Field>
          <Field label="Priority">
            {(p) => (
              <NativeSelect
                {...p}
                value={v.priority}
                onChange={(e) => setV({ ...v, priority: e.target.value as Priority })}
              >
                {(Object.keys(PRIORITY_LABEL) as Priority[]).map((k) => (
                  <option key={k} value={k}>
                    {PRIORITY_LABEL[k]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Received by">
            {(p) => (
              <NativeSelect
                {...p}
                value={v.channel}
                onChange={(e) => setV({ ...v, channel: e.target.value })}
              >
                <option value="staff">Logged by staff</option>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
              </NativeSelect>
            )}
          </Field>
          <Field
            label="Category"
            className="sm:col-span-2"
            help="Optional, for example Facilities, Billing or Access."
          >
            {(p) => (
              <Input {...p} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />
            )}
          </Field>
          <Field label="Description" className="sm:col-span-2">
            {(p) => (
              <Textarea
                {...p}
                rows={4}
                value={v.description}
                onChange={(e) => setV({ ...v, description: e.target.value })}
              />
            )}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TicketsList() {
  const can = useCan();
  const nav = useNavigate();
  const nouns = useNouns();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get('tab')) ?? TABS[0]!;
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: [...KEY, 'list', tab.key, q],
    queryFn: () =>
      apiGet<{ data: Ticket[]; meta: { total: number } }>(BASE, { ...tab.query, q, pageSize: 100 }),
    placeholderData: keepPreviousData,
  });
  const create = can('tickets.tickets.create');
  return (
    <div>
      <PageHeader
        title={nouns.many}
        actions={
          create ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> New {nouns.one.toLowerCase()}
            </Button>
          ) : null
        }
      >
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Views">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setParams(t.key === 'active' ? {} : { tab: t.key })}
              aria-current={tab.key === t.key ? 'page' : undefined}
              className="border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted hover:text-ink aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-ink"
            >
              {t.label}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute start-2.5 top-2 size-4 text-faint" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by number or subject"
            aria-label="Search"
            className="ps-8"
          />
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data.data.length ? (
          <EmptyState
            icon={<LifeBuoy />}
            title={
              tab.key === 'active' && !q ? 'Nothing waiting. Nice.' : `No ${nouns.many.toLowerCase()} here`
            }
            action={
              tab.key === 'active' && !q && create ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus /> New {nouns.one.toLowerCase()}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {list.data.data.map((t) => (
              <li key={t.uuid}>
                <Link
                  to={`${ROOT}/${t.uuid}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{t.subject}</span>
                      {t.responseOverdue || t.resolutionOverdue ? (
                        <AlertTriangle className="size-4 shrink-0 text-accent" aria-label="Overdue" />
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      <span className="font-mono">{t.number}</span>
                      {t.contact ? ` · ${t.contact.name}` : ''}
                      {t.category ? ` · ${t.category}` : ''} · {formatRelative(t.lastActivityAt)}
                    </span>
                  </span>
                  <PriorityBadge p={t.priority} />
                  <Badge tone={t.status === 'open' ? 'primary' : 'neutral'}>{STATUS_LABEL[t.status]}</Badge>
                  <span className="hidden w-32 truncate text-end text-xs text-muted sm:block">
                    {t.assignee?.name ?? 'Unassigned'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      {creating ? (
        <NewTicketDialog onDone={(uuid) => (setCreating(false), uuid && nav(`${ROOT}/${uuid}`))} />
      ) : null}
    </div>
  );
}

function Due({
  label,
  at,
  done,
  overdue,
}: {
  label: string;
  at: string | null;
  done: string | null;
  overdue: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('text-sm', overdue && 'font-medium text-accent')}>
        {done
          ? `Done ${formatRelative(done)}`
          : at
            ? `${overdue ? 'Overdue · ' : 'Due '}${formatRelative(at)}`
            : '—'}
      </dd>
    </div>
  );
}

function TicketDetail() {
  const { uuid = '' } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const L = labelVars(useBoot().labels);
  const ticket = useQuery({
    queryKey: [...KEY, 'one', uuid],
    queryFn: () => apiGet<Ticket>(`${BASE}/${uuid}`),
  });
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const reply = useMutation({
    mutationFn: (status?: Status) => apiPost(`${BASE}/${uuid}/comments`, { body, internal, status }),
    onSuccess: () => {
      toast.success(internal ? 'Note added' : 'Reply sent');
      setBody('');
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => apiPatch(`${BASE}/${uuid}`, patch),
    onSuccess: () => {
      toast.success('Saved');
      refresh();
    },
  });
  if (ticket.isPending)
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Skeleton className="h-96" />
      </div>
    );
  if (ticket.isError) return <ErrorState error={ticket.error} onRetry={() => void ticket.refetch()} />;
  const t = ticket.data;
  const edit = can('tickets.tickets.update');
  return (
    <div>
      <PageHeader
        title={t.subject}
        description={
          <span>
            <Link to={ROOT} className="text-primary hover:underline">
              ← All
            </Link>{' '}
            · <span className="font-mono">{t.number}</span> · opened {formatDateTime(t.createdAt)}
            {t.channel === 'portal' ? ' from the client portal' : ''}
          </span>
        }
        actions={
          edit && (t.status === 'open' || t.status === 'pending') ? (
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={() => update.mutate({ status: 'resolved' })}
            >
              Resolve
            </Button>
          ) : edit ? (
            <Button onClick={() => update.mutate({ status: 'open' })}>Reopen</Button>
          ) : null
        }
      />
      <div className="mx-auto grid max-w-6xl gap-4 p-4 md:p-6 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-3">
          {t.description ? (
            <Pane>
              <p className="text-sm whitespace-pre-wrap">{t.description}</p>
            </Pane>
          ) : null}
          <ol className="flex flex-col gap-3" aria-label="Conversation">
            {(t.comments ?? []).map((c) => (
              <li
                key={c.uuid}
                className={cn(
                  'rounded-md border p-3',
                  c.internal
                    ? 'border-dashed border-line-strong bg-subtle'
                    : c.fromCustomer
                      ? 'border-line bg-surface'
                      : 'border-primary-soft bg-primary-soft/40',
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                  <Avatar name={c.author?.name ?? '?'} size="sm" />
                  <span className="font-medium text-ink">{c.author?.name ?? 'Someone'}</span>
                  {c.internal ? (
                    <span className="inline-flex items-center gap-1">
                      <Lock className="size-3" /> Internal note
                    </span>
                  ) : c.fromCustomer ? (
                    'Customer'
                  ) : (
                    'Reply'
                  )}
                  <span className="ms-auto">{formatDateTime(c.createdAt)}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ol>
          {edit ? (
            <Pane>
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (body.trim()) reply.mutate(undefined);
                }}
              >
                <div className="flex gap-1" role="radiogroup" aria-label="Type">
                  {[
                    [false, 'Reply'],
                    [true, 'Internal note'],
                  ].map(([val, label]) => (
                    <button
                      key={String(label)}
                      type="button"
                      role="radio"
                      aria-checked={internal === val}
                      onClick={() => setInternal(val as boolean)}
                      className="rounded-sm px-2.5 py-1 text-xs text-muted aria-checked:bg-subtle aria-checked:font-medium aria-checked:text-ink"
                    >
                      {label as string}
                    </button>
                  ))}
                </div>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  aria-label={internal ? 'Internal note' : 'Reply'}
                  placeholder={
                    internal
                      ? 'Only your team sees this'
                      : t.contact
                        ? `Visible to ${t.contact.name} in the portal`
                        : 'Write a reply'
                  }
                  className={internal ? 'bg-subtle' : undefined}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  {!internal ? (
                    <Button
                      type="button"
                      disabled={!body.trim()}
                      loading={reply.isPending}
                      onClick={() => reply.mutate('pending')}
                    >
                      Send and wait for customer
                    </Button>
                  ) : null}
                  <Button type="submit" variant="primary" disabled={!body.trim()} loading={reply.isPending}>
                    {internal ? 'Add note' : 'Send reply'}
                  </Button>
                </div>
              </form>
            </Pane>
          ) : null}
        </div>
        <aside className="flex flex-col gap-3">
          <Pane title="Details">
            <div className="flex flex-col gap-3">
              <Field label="Status">
                {(p) => (
                  <NativeSelect
                    {...p}
                    value={t.status}
                    disabled={!edit}
                    onChange={(e) => update.mutate({ status: e.target.value })}
                  >
                    {(Object.keys(STATUS_LABEL) as Status[]).map((k) => (
                      <option key={k} value={k}>
                        {STATUS_LABEL[k]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Priority">
                {(p) => (
                  <NativeSelect
                    {...p}
                    value={t.priority}
                    disabled={!edit}
                    onChange={(e) => update.mutate({ priority: e.target.value })}
                  >
                    {(Object.keys(PRIORITY_LABEL) as Priority[]).map((k) => (
                      <option key={k} value={k}>
                        {PRIORITY_LABEL[k]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Assignee">
                {(p) => (
                  <UserPicker
                    {...p}
                    value={t.assignee?.uuid ?? null}
                    disabled={!edit}
                    onChange={(u) => update.mutate({ assigneeUuid: u })}
                  />
                )}
              </Field>
              <Field label={L.contact}>
                {(p) => (
                  <RecordPicker
                    {...p}
                    route="contacts"
                    value={t.contact?.uuid ?? null}
                    label={t.contact?.name}
                    disabled={!edit}
                    onChange={(u) => update.mutate({ contactUuid: u })}
                  />
                )}
              </Field>
              {t.contact ? (
                <Link to={`/contacts/${t.contact.uuid}`} className="text-xs text-primary hover:underline">
                  Open {L.contactLower}
                </Link>
              ) : null}
            </div>
          </Pane>
          <Pane title="Targets">
            <dl className="flex flex-col gap-2">
              <Due
                label="First response"
                at={t.firstResponseDueAt}
                done={t.firstRespondedAt}
                overdue={t.responseOverdue}
              />
              <Due label="Resolution" at={t.resolveDueAt} done={t.resolvedAt} overdue={t.resolutionOverdue} />
            </dl>
          </Pane>
        </aside>
      </div>
    </div>
  );
}

function OpenTicketsWidget({ data }: { data: unknown }) {
  const d = data as { open: number; mine: number; unassigned: number; urgent: number; overdue: number };
  const stats: [string, number, string][] = [
    ['Open', d.open, ''],
    ['Mine', d.mine, '?tab=mine'],
    ['Unassigned', d.unassigned, '?tab=unassigned'],
    ['Overdue', d.overdue, '?tab=overdue'],
  ];
  return (
    <dl className="grid flex-1 grid-cols-2 gap-3">
      {stats.map(([label, n, to]) => (
        <Link key={label} to={`${ROOT}${to}`} className="rounded-md p-1 hover:bg-hover">
          <dt className="text-xs text-muted">{label}</dt>
          <dd
            className={cn(
              'text-2xl font-semibold tracking-tight tabular-nums',
              label === 'Overdue' && n > 0 && 'text-accent',
            )}
          >
            {n}
          </dd>
        </Link>
      ))}
    </dl>
  );
}

const ticketsModule: WebModule = {
  key: 'tickets',
  routes: [
    { path: '', element: <TicketsList /> },
    { path: ':uuid', element: <TicketDetail /> },
  ],
  widgets: { 'tickets.open_count': (p) => <OpenTicketsWidget data={p.data} /> },
};

export default ticketsModule;
