import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ClipboardList, Pencil, Play, Plus, Printer, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, PageHeader, Pane, Skeleton } from '@/components/ui/misc';
import { RecordPicker } from '@/components/fields/pickers';
import type { RecordRef } from '@/components/commerce/document-paper';

type Status = 'draft' | 'active' | 'expired' | 'cancelled' | 'renewed';
type Cycle = 'none' | 'monthly' | 'quarterly' | 'yearly';

interface Contract {
  uuid: string;
  number: string;
  title: string;
  status: Status;
  contact: RecordRef | null;
  organization: RecordRef | null;
  deal: RecordRef | null;
  owner: { uuid: string; name: string } | null;
  startDate: string | null;
  endDate: string | null;
  signedOn: string | null;
  currency: string;
  value: number;
  billingCycle: Cycle;
  autoRenew: boolean;
  renewalTermMonths: number;
  noticeDays: number | null;
  effectiveNoticeDays: number;
  daysLeft: number | null;
  renewalDue: boolean;
  renewedFrom: { uuid: string; number: string } | null;
  renewedToUuid: string | null;
  cancelReason: string | null;
  description: string | null;
  terms: string | null;
}

const BASE = '/m/contracts/contracts';
const ROOT = '/m/contracts';
const KEY = ['m', 'contracts'] as const;
const STATUS_LABEL: Record<Status, string> = {
  draft: 'Draft',
  active: 'Active',
  expired: 'Expired',
  cancelled: 'Cancelled',
  renewed: 'Renewed',
};
const CYCLE_LABEL: Record<Cycle, string> = {
  none: 'One-off',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

function ContractStatus({ c }: { c: Pick<Contract, 'status' | 'renewalDue'> }) {
  if (c.renewalDue) return <Badge tone="accent">Renewal due</Badge>;
  const tone = c.status === 'active' ? 'primary' : c.status === 'draft' ? 'neutral' : 'outline';
  return <Badge tone={tone}>{STATUS_LABEL[c.status]}</Badge>;
}

function useNouns() {
  const L = labelVars(useBoot().labels);
  return { one: L.contract ?? 'Contract', many: L.contractPlural ?? 'Contracts' };
}

const TABS: [string, string][] = [
  ['', 'All'],
  ['renewing', 'Renewing soon'],
  ['active', 'Active'],
  ['draft', 'Draft'],
  ['expired', 'Expired'],
  ['cancelled', 'Cancelled'],
];

function ContractsList() {
  const can = useCan();
  const nouns = useNouns();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: [...KEY, 'list', status, q],
    queryFn: () => apiGet<{ data: Contract[] }>(BASE, { status: status || undefined, q, pageSize: 100 }),
    placeholderData: keepPreviousData,
  });
  const create = can('contracts.contracts.create');
  const newButton = (
    <Button variant="primary" asChild>
      <Link to={`${ROOT}/new`}>
        <Plus /> New {nouns.one.toLowerCase()}
      </Link>
    </Button>
  );
  return (
    <div>
      <PageHeader title={nouns.many} actions={create ? newButton : null}>
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Filter by status">
          {TABS.map(([key, label]) => (
            <button
              key={key || 'all'}
              type="button"
              onClick={() => setParams(key ? { status: key } : {})}
              aria-current={status === key ? 'page' : undefined}
              className="border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted hover:text-ink aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-ink"
            >
              {label}
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
            placeholder="Search by number or title"
            aria-label={`Search ${nouns.many.toLowerCase()}`}
            className="ps-8"
          />
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data.data.length ? (
          <EmptyState
            icon={<ClipboardList />}
            title={
              status === 'renewing'
                ? 'Nothing is due for renewal'
                : q || status
                  ? `No ${nouns.many.toLowerCase()} match`
                  : `No ${nouns.many.toLowerCase()} yet`
            }
            description={!q && !status ? 'Track agreements and get reminded before they end.' : undefined}
            action={!q && !status && create ? newButton : undefined}
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-line bg-subtle text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">Contract</th>
                  <th className="px-4 py-2 text-start font-medium">With</th>
                  <th className="px-4 py-2 text-start font-medium">Status</th>
                  <th className="px-4 py-2 text-start font-medium">Ends</th>
                  <th className="px-4 py-2 text-end font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {list.data.data.map((c) => (
                  <tr key={c.uuid} className="border-b border-line last:border-0 hover:bg-hover">
                    <td className="px-4 py-2.5">
                      <Link to={`${ROOT}/${c.uuid}`} className="font-medium hover:underline">
                        {c.title}
                      </Link>
                      <p className="font-mono text-xs text-muted">{c.number}</p>
                    </td>
                    <td className="px-4 py-2.5">{c.organization?.name ?? c.contact?.name ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <ContractStatus c={c} />
                    </td>
                    <td className="px-4 py-2.5">
                      {c.endDate ? formatDate(c.endDate) : <span className="text-muted">Open-ended</span>}
                      {c.status === 'active' && c.daysLeft !== null && c.daysLeft >= 0 ? (
                        <span className="block text-xs text-muted">
                          in {c.daysLeft} {c.daysLeft === 1 ? 'day' : 'days'}
                          {c.autoRenew ? ' · auto-renews' : ''}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {formatMoney(c.value, c.currency)}
                      {c.billingCycle !== 'none' ? (
                        <span className="block text-xs text-muted">{CYCLE_LABEL[c.billingCycle]}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

interface FormState {
  title: string;
  organization: RecordRef | null;
  contact: RecordRef | null;
  deal: RecordRef | null;
  startDate: string;
  endDate: string;
  signedOn: string;
  currency: string;
  value: string;
  billingCycle: Cycle;
  autoRenew: boolean;
  renewalTermMonths: string;
  noticeDays: string;
  description: string;
  terms: string;
}

function ContractEditor() {
  const { uuid } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const boot = useBoot();
  const can = useCan();
  const nouns = useNouns();
  const L = labelVars(boot.labels);
  const existing = useQuery({
    queryKey: [...KEY, 'one', uuid],
    queryFn: () => apiGet<Contract>(`${BASE}/${uuid}`),
    enabled: !!uuid,
  });
  if (uuid && existing.isPending) return <Skeleton className="m-6 h-96" />;
  if (uuid && existing.isError) return <ErrorState error={existing.error} />;
  const c = existing.data;
  const initial: FormState = {
    title: c?.title ?? '',
    organization: c?.organization ?? null,
    contact: c?.contact ?? null,
    deal: c?.deal ?? null,
    startDate: c?.startDate ?? '',
    endDate: c?.endDate ?? '',
    signedOn: c?.signedOn ?? '',
    currency: c?.currency ?? boot.settings.general.currency,
    value: String(c?.value ?? ''),
    billingCycle: c?.billingCycle ?? 'none',
    autoRenew: c?.autoRenew ?? false,
    renewalTermMonths: String(c?.renewalTermMonths ?? 12),
    noticeDays: c?.noticeDays ? String(c.noticeDays) : '',
    description: c?.description ?? '',
    terms: c?.terms ?? '',
  };
  return (
    <ContractForm
      key={uuid ?? 'new'}
      initial={initial}
      active={c?.status === 'active'}
      title={c ? `Edit ${c.number}` : `New ${nouns.one.toLowerCase()}`}
      labels={{ organization: L.organization!, contact: L.contact!, deal: L.deal! }}
      canPick={{
        organization: can('core.organizations.view'),
        contact: can('core.contacts.view'),
        deal: can('core.deals.view'),
      }}
      onSaved={(saved) => {
        toast.success(uuid ? `${nouns.one} saved` : `${nouns.one} created`);
        void qc.invalidateQueries({ queryKey: KEY });
        nav(`${ROOT}/${saved.uuid}`, { replace: true });
      }}
      onCancel={() => nav(c ? `${ROOT}/${c.uuid}` : ROOT)}
      save={(body) => (uuid ? apiPatch<Contract>(`${BASE}/${uuid}`, body) : apiPost<Contract>(BASE, body))}
    />
  );
}

function ContractForm({
  initial,
  active,
  title,
  labels,
  canPick,
  save,
  onSaved,
  onCancel,
}: {
  initial: FormState;
  active: boolean;
  title: string;
  labels: Record<'organization' | 'contact' | 'deal', string>;
  canPick: Record<'organization' | 'contact' | 'deal', boolean>;
  save: (body: Record<string, unknown>) => Promise<Contract>;
  onSaved: (c: Contract) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const set = <K extends keyof FormState>(k: K, val: FormState[K]) => setV((s) => ({ ...s, [k]: val }));
  const mutation = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        title: v.title,
        organizationUuid: v.organization?.uuid ?? null,
        contactUuid: v.contact?.uuid ?? null,
        dealUuid: v.deal?.uuid ?? null,
        signedOn: v.signedOn || null,
        autoRenew: v.autoRenew,
        renewalTermMonths: Number(v.renewalTermMonths || 12),
        noticeDays: v.noticeDays ? Number(v.noticeDays) : null,
        description: v.description || null,
      };
      // Dates, value and terms are locked once a contract is active.
      if (!active)
        Object.assign(body, {
          startDate: v.startDate || null,
          endDate: v.endDate || null,
          currency: v.currency,
          value: Number(v.value || 0),
          billingCycle: v.billingCycle,
          terms: v.terms || null,
        });
      return save(body);
    },
    onSuccess: onSaved,
  });
  const errors = mutation.error instanceof ApiError ? mutation.error.fieldErrors() : {};
  const pick = (key: 'organization' | 'contact' | 'deal', route: string) =>
    canPick[key] ? (
      <Field label={labels[key]} error={errors[`${key}Uuid`]}>
        {(p) => (
          <RecordPicker
            {...p}
            route={route}
            value={v[key]?.uuid ?? null}
            label={v[key]?.name}
            onChange={(uuid, name) => set(key, uuid ? { uuid, name: name ?? '' } : null)}
          />
        )}
      </Field>
    ) : null;
  return (
    <div>
      <PageHeader title={title} />
      <form
        className="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        noValidate
      >
        <Pane title="Agreement">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Title" required className="md:col-span-2" error={errors.title}>
              {(p) => <Input {...p} value={v.title} onChange={(e) => set('title', e.target.value)} />}
            </Field>
            {pick('organization', 'organizations')}
            {pick('contact', 'contacts')}
            {pick('deal', 'deals')}
            <Field label="Signed on">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={v.signedOn}
                  onChange={(e) => set('signedOn', e.target.value)}
                />
              )}
            </Field>
          </div>
        </Pane>
        <Pane
          title="Term and value"
          actions={active ? <span className="text-xs text-muted">Locked while active</span> : null}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Start date" error={errors.startDate} help="Needed to activate.">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={v.startDate}
                  disabled={active}
                  onChange={(e) => set('startDate', e.target.value)}
                />
              )}
            </Field>
            <Field label="End date" error={errors.endDate} help="Leave empty for open-ended.">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={v.endDate}
                  disabled={active}
                  onChange={(e) => set('endDate', e.target.value)}
                />
              )}
            </Field>
            <Field label="Billing">
              {(p) => (
                <NativeSelect
                  {...p}
                  value={v.billingCycle}
                  disabled={active}
                  onChange={(e) => set('billingCycle', e.target.value as Cycle)}
                >
                  {(Object.keys(CYCLE_LABEL) as Cycle[]).map((k) => (
                    <option key={k} value={k}>
                      {CYCLE_LABEL[k]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Value" error={errors.value} help="Per billing period, or the total if one-off.">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  value={v.value}
                  disabled={active}
                  onChange={(e) => set('value', e.target.value)}
                />
              )}
            </Field>
            <Field label="Currency">
              {(p) => (
                <Input
                  {...p}
                  value={v.currency}
                  disabled={active}
                  onChange={(e) => set('currency', e.target.value.toUpperCase().slice(0, 3))}
                  className="w-24 uppercase"
                />
              )}
            </Field>
          </div>
        </Pane>
        <Pane title="Renewal">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex items-center gap-2 self-end text-sm sm:col-span-2 lg:col-span-3">
              <input
                type="checkbox"
                checked={v.autoRenew}
                onChange={(e) => set('autoRenew', e.target.checked)}
                className="size-4 accent-primary"
              />
              Renew automatically at the end date
            </label>
            <Field label="Renewal term (months)">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  max={120}
                  value={v.renewalTermMonths}
                  onChange={(e) => set('renewalTermMonths', e.target.value)}
                />
              )}
            </Field>
            <Field label="Remind me (days before end)" help="Leave empty to use the workspace default.">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  max={365}
                  value={v.noticeDays}
                  onChange={(e) => set('noticeDays', e.target.value)}
                />
              )}
            </Field>
          </div>
        </Pane>
        <Pane title="Details">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Description">
              {(p) => (
                <Textarea {...p} value={v.description} onChange={(e) => set('description', e.target.value)} />
              )}
            </Field>
            <Field label="Terms">
              {(p) => (
                <Textarea
                  {...p}
                  value={v.terms}
                  disabled={active}
                  onChange={(e) => set('terms', e.target.value)}
                />
              )}
            </Field>
          </div>
        </Pane>
        {mutation.error && !Object.keys(errors).length ? (
          <p role="alert" className="text-sm text-accent">
            {mutation.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending} disabled={!v.title.trim()}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}

function CancelDialog({ contract, onDone }: { contract: Contract; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => apiPost(`${BASE}/${contract.uuid}/cancel`, { reason }),
    onSuccess: () => {
      toast.success('Cancelled');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={`Cancel ${contract.number}`}
        description="The contract ends now and will not renew."
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={cancel.isPending}
              disabled={!reason.trim()}
              onClick={() => cancel.mutate()}
            >
              Cancel contract
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
        </Field>
      </DialogContent>
    </Dialog>
  );
}

function ContractDetail() {
  const { uuid = '' } = useParams();
  const nav = useNavigate();
  const can = useCan();
  const boot = useBoot();
  const qc = useQueryClient();
  const L = labelVars(boot.labels);
  const [cancelling, setCancelling] = useState(false);
  const contract = useQuery({
    queryKey: [...KEY, 'one', uuid],
    queryFn: () => apiGet<Contract>(`${BASE}/${uuid}`),
  });
  const activate = useMutation({
    mutationFn: () => apiPost(`${BASE}/${uuid}/activate`),
    onSuccess: () => {
      toast.success('Activated');
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast.error(e.message),
  });
  const renew = useMutation({
    mutationFn: () => apiPost<Contract>(`${BASE}/${uuid}/renew`),
    onSuccess: (next) => {
      toast.success('Renewed');
      void qc.invalidateQueries({ queryKey: KEY });
      nav(`${ROOT}/${next.uuid}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`${BASE}/${uuid}`),
    onSuccess: () => {
      toast.success('Deleted');
      void qc.invalidateQueries({ queryKey: KEY });
      nav(ROOT);
    },
  });
  if (contract.isPending)
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Skeleton className="h-96" />
      </div>
    );
  if (contract.isError) return <ErrorState error={contract.error} onRetry={() => void contract.refetch()} />;
  const c = contract.data;
  const update = can('contracts.contracts.update');
  const facts: [string, React.ReactNode][] = [
    [L.organization!, c.organization?.name ?? '—'],
    [L.contact!, c.contact?.name ?? '—'],
    ['Start', formatDate(c.startDate) || '—'],
    ['End', c.endDate ? formatDate(c.endDate) : 'Open-ended'],
    [
      'Value',
      `${formatMoney(c.value, c.currency, true)}${c.billingCycle !== 'none' ? ` · ${CYCLE_LABEL[c.billingCycle]}` : ''}`,
    ],
    ['Renewal', c.autoRenew ? `Automatic, ${c.renewalTermMonths} months` : 'Manual'],
    ['Reminder', `${c.effectiveNoticeDays} days before end`],
    ['Signed', formatDate(c.signedOn) || '—'],
    ['Owner', c.owner?.name ?? '—'],
  ];
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {c.title} <ContractStatus c={c} />
          </span>
        }
        description={
          <span className="font-mono">
            {c.number}
            {c.deal ? (
              <>
                {' · '}
                <Link to={`/deals/${c.deal.uuid}`} className="font-sans text-primary hover:underline">
                  {c.deal.name}
                </Link>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            {update && (c.status === 'draft' || c.status === 'active') ? (
              <Button asChild>
                <Link to={`${ROOT}/${c.uuid}/edit`}>
                  <Pencil /> Edit
                </Link>
              </Button>
            ) : null}
            {update && c.status === 'draft' ? (
              <Button variant="primary" loading={activate.isPending} onClick={() => activate.mutate()}>
                <Play /> Activate
              </Button>
            ) : null}
            {update && (c.status === 'active' || c.status === 'expired') && c.endDate ? (
              <Button
                variant={c.renewalDue || c.status === 'expired' ? 'primary' : 'secondary'}
                loading={renew.isPending}
                onClick={() => renew.mutate()}
              >
                <RefreshCw /> Renew
              </Button>
            ) : null}
            {update && c.status === 'active' ? (
              <Button variant="ghost" onClick={() => setCancelling(true)}>
                <Ban /> Cancel
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {can('contracts.contracts.delete') && c.status === 'draft' ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete"
                onClick={() => {
                  if (window.confirm(`Delete draft ${c.number}?`)) remove.mutate();
                }}
              >
                <Trash2 />
              </Button>
            ) : null}
          </>
        }
      />
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6">
        {c.renewalDue ? (
          <p className="rounded-md border border-line bg-accent-soft px-4 py-2 text-sm print:hidden">
            {c.autoRenew
              ? `Renews automatically in ${c.daysLeft} days.`
              : `Ends in ${c.daysLeft} days. Renew it or let it expire.`}
          </p>
        ) : null}
        {c.status === 'cancelled' && c.cancelReason ? (
          <p className="rounded-md border border-line bg-subtle px-4 py-2 text-sm">
            Cancelled: {c.cancelReason}
          </p>
        ) : null}
        {c.renewedFrom || c.renewedToUuid ? (
          <p className="text-sm text-muted print:hidden">
            {c.renewedFrom ? (
              <>
                Renews{' '}
                <Link to={`${ROOT}/${c.renewedFrom.uuid}`} className="text-primary hover:underline">
                  {c.renewedFrom.number}
                </Link>
                .{' '}
              </>
            ) : null}
            {c.renewedToUuid ? (
              <Link to={`${ROOT}/${c.renewedToUuid}`} className="text-primary hover:underline">
                See the next term
              </Link>
            ) : null}
          </p>
        ) : null}
        <Pane title="Summary">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </Pane>
        {c.description ? (
          <Pane title="Description">
            <p className="text-sm whitespace-pre-line">{c.description}</p>
          </Pane>
        ) : null}
        {c.terms ? (
          <Pane title="Terms">
            <p className="text-sm whitespace-pre-line">{c.terms}</p>
          </Pane>
        ) : null}
      </div>
      {cancelling ? <CancelDialog contract={c} onDone={() => setCancelling(false)} /> : null}
    </div>
  );
}

interface Renewals {
  contracts: {
    uuid: string;
    number: string;
    title: string;
    endDate: string;
    daysLeft: number;
    autoRenew: boolean;
    organization: RecordRef | null;
  }[];
}

function RenewalsWidget({ data }: { data: unknown }) {
  const { contracts } = data as Renewals;
  if (!contracts.length)
    return (
      <p className="flex flex-1 items-center justify-center text-sm text-muted">
        No renewals in the next 60 days.
      </p>
    );
  return (
    <ul className="flex flex-1 flex-col">
      {contracts.map((c) => (
        <li key={c.uuid} className="border-b border-line py-2 last:border-0">
          <Link to={`${ROOT}/${c.uuid}`} className="flex items-baseline gap-2 text-sm hover:underline">
            <span className="min-w-0 flex-1 truncate font-medium">{c.organization?.name ?? c.title}</span>
            <span className={c.daysLeft <= 14 ? 'text-accent' : 'text-muted'}>
              {c.daysLeft === 0 ? 'today' : `${c.daysLeft}d`}
            </span>
          </Link>
          <p className="text-xs text-muted">
            {c.number} · {formatDate(c.endDate)}
            {c.autoRenew ? ' · auto-renews' : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}

const contractsModule: WebModule = {
  key: 'contracts',
  routes: [
    { path: '', element: <ContractsList /> },
    { path: 'new', element: <ContractEditor /> },
    { path: ':uuid', element: <ContractDetail /> },
    { path: ':uuid/edit', element: <ContractEditor /> },
  ],
  widgets: { 'contracts.renewals': (p) => <RenewalsWidget data={p.data} /> },
};

export default contractsModule;
