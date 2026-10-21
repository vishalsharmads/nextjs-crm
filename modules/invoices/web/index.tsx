import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Copy, CreditCard, Pencil, Plus, Printer, Receipt, Search, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PAYMENT_METHODS } from '@app/shared';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, PageHeader, Pane, Skeleton } from '@/components/ui/misc';
import { DocumentPaper, type RecordRef } from '@/components/commerce/document-paper';
import {
  DocumentForm,
  emptyDocument,
  toDocumentBody,
  type DocumentFormValues,
} from '@/components/commerce/document-form';
import { toEditable, type LineDto } from '@/components/commerce/line-items';

type Status = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void';

interface Payment {
  uuid: string;
  amount: number;
  paidOn: string;
  method: (typeof PAYMENT_METHODS)[number];
  reference: string | null;
  note: string | null;
}

interface Invoice {
  uuid: string;
  number: string;
  title: string;
  status: Status;
  overdue: boolean;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  contact: RecordRef | null;
  organization: RecordRef | null;
  deal: RecordRef | null;
  total: number;
  amountPaid: number;
  balanceDue: number;
  notes: string | null;
  terms: string | null;
  paymentInstructions: string | null;
  voidReason: string | null;
  sourceQuoteUuid: string | null;
  lines?: LineDto[];
  payments?: Payment[];
}

const BASE = '/m/invoices/invoices';
const ROOT = '/m/invoices';
const KEY = ['m', 'invoices'] as const;

const STATUS_LABEL: Record<Status, string> = {
  draft: 'Draft',
  issued: 'Issued',
  partially_paid: 'Partly paid',
  paid: 'Paid',
  void: 'Void',
};
const METHOD_LABEL: Record<Payment['method'], string> = {
  bank_transfer: 'Bank transfer',
  card: 'Card',
  cash: 'Cash',
  cheque: 'Cheque',
  other: 'Other',
};

export function InvoiceStatus({ invoice }: { invoice: Pick<Invoice, 'status' | 'overdue'> }) {
  if (invoice.overdue) return <Badge tone="accent">Overdue</Badge>;
  const tone =
    invoice.status === 'paid'
      ? 'primary'
      : invoice.status === 'void'
        ? 'neutral'
        : invoice.status === 'draft'
          ? 'neutral'
          : 'outline';
  return <Badge tone={tone}>{STATUS_LABEL[invoice.status]}</Badge>;
}

function useNouns() {
  const L = labelVars(useBoot().labels);
  return { one: L.invoice ?? 'Invoice', many: L.invoicePlural ?? 'Invoices' };
}

const TABS: [string, string][] = [
  ['', 'All'],
  ['draft', 'Draft'],
  ['open', 'Open'],
  ['overdue', 'Overdue'],
  ['paid', 'Paid'],
  ['void', 'Void'],
];

function InvoicesList() {
  const can = useCan();
  const nouns = useNouns();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: [...KEY, 'list', status, q],
    queryFn: () =>
      apiGet<{ data: Invoice[]; meta: { total: number } }>(BASE, {
        status: status || undefined,
        q,
        pageSize: 100,
      }),
    placeholderData: keepPreviousData,
  });
  const create = can('invoices.invoices.create');
  return (
    <div>
      <PageHeader
        title={nouns.many}
        actions={
          create ? (
            <Button variant="primary" asChild>
              <Link to={`${ROOT}/new`}>
                <Plus /> New {nouns.one.toLowerCase()}
              </Link>
            </Button>
          ) : null
        }
      >
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Filter by status">
          {TABS.map(([key, label]) => (
            <button
              key={key || 'all'}
              type="button"
              onClick={() => setParams(key ? { status: key } : {})}
              aria-current={status === key ? 'page' : undefined}
              className="border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-ink"
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
            icon={<Receipt />}
            title={
              q || status ? `No ${nouns.many.toLowerCase()} match` : `No ${nouns.many.toLowerCase()} yet`
            }
            description={!q && !status ? 'Bill a customer, then record payments as they come in.' : undefined}
            action={
              !q && !status && create ? (
                <Button variant="primary" asChild>
                  <Link to={`${ROOT}/new`}>
                    <Plus /> New {nouns.one.toLowerCase()}
                  </Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-line bg-subtle text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">Number</th>
                  <th className="px-4 py-2 text-start font-medium">Billed to</th>
                  <th className="px-4 py-2 text-start font-medium">Status</th>
                  <th className="px-4 py-2 text-start font-medium">Due</th>
                  <th className="px-4 py-2 text-end font-medium">Total</th>
                  <th className="px-4 py-2 text-end font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {list.data.data.map((x) => (
                  <tr key={x.uuid} className="border-b border-line last:border-0 hover:bg-hover">
                    <td className="px-4 py-2.5">
                      <Link to={`${ROOT}/${x.uuid}`} className="font-mono font-medium hover:underline">
                        {x.number}
                      </Link>
                      {x.title ? <p className="line-clamp-1 text-xs text-muted">{x.title}</p> : null}
                    </td>
                    <td className="px-4 py-2.5">{x.organization?.name ?? x.contact?.name ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <InvoiceStatus invoice={x} />
                    </td>
                    <td className={`px-4 py-2.5 ${x.overdue ? 'font-medium text-accent' : 'text-muted'}`}>
                      {formatDate(x.dueDate)}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {formatMoney(x.total, x.currency, true)}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {x.status === 'draft' || x.status === 'void'
                        ? '—'
                        : formatMoney(x.balanceDue, x.currency, true)}
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

const DATE_FIELDS = [
  { key: 'issueDate', label: 'Issue date', help: 'Defaults to today.' },
  { key: 'dueDate', label: 'Due date', help: 'Defaults from your settings.' },
];

function useInvoice(uuid: string) {
  return useQuery({
    queryKey: [...KEY, 'one', uuid],
    queryFn: () => apiGet<Invoice>(`${BASE}/${uuid}`),
    enabled: !!uuid,
  });
}

function InvoiceEditor() {
  const { uuid } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const boot = useBoot();
  const nouns = useNouns();
  const existing = useInvoice(uuid ?? '');
  const save = useMutation({
    mutationFn: (v: DocumentFormValues) =>
      uuid
        ? apiPatch<Invoice>(`${BASE}/${uuid}`, toDocumentBody(v))
        : apiPost<Invoice>(BASE, toDocumentBody(v)),
    onSuccess: (inv) => {
      toast.success(uuid ? `${nouns.one} saved` : `${nouns.one} created`);
      void qc.invalidateQueries({ queryKey: KEY });
      nav(`${ROOT}/${inv.uuid}`, { replace: true });
    },
  });
  if (uuid && existing.isPending) return <Skeleton className="m-6 h-96" />;
  if (uuid && existing.isError) return <ErrorState error={existing.error} />;
  const inv = existing.data;
  const initial: DocumentFormValues = inv
    ? {
        title: inv.title,
        organization: inv.organization,
        contact: inv.contact,
        deal: inv.deal,
        currency: inv.currency,
        dates: { issueDate: inv.issueDate, dueDate: inv.dueDate ?? '' },
        notes: inv.notes ?? '',
        terms: inv.terms ?? '',
        lines: toEditable(inv.lines ?? []),
      }
    : emptyDocument(boot.settings.general.currency, boot.settings.commerce.defaultTaxRate);
  return (
    <div>
      <PageHeader title={inv ? `Edit ${inv.number}` : `New ${nouns.one.toLowerCase()}`} />
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        <DocumentForm
          initial={initial}
          dateFields={DATE_FIELDS}
          submitLabel={inv ? 'Save changes' : `Create ${nouns.one.toLowerCase()}`}
          submitting={save.isPending}
          error={save.error}
          onSubmit={(v) => save.mutate(v)}
          onCancel={() => nav(inv ? `${ROOT}/${inv.uuid}` : ROOT)}
        />
      </div>
    </div>
  );
}

function PaymentDialog({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    amount: String(invoice.balanceDue),
    paidOn: new Date().toISOString().slice(0, 10),
    method: 'bank_transfer' as Payment['method'],
    reference: '',
  });
  const record = useMutation({
    mutationFn: () =>
      apiPost(`${BASE}/${invoice.uuid}/payments`, {
        ...v,
        amount: Number(v.amount),
        reference: v.reference || null,
      }),
    onSuccess: () => {
      toast.success('Payment recorded');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  const errors = record.error instanceof ApiError ? record.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title="Record payment"
        description={`Balance due: ${formatMoney(invoice.balanceDue, invoice.currency, true)}`}
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={record.isPending}
              disabled={!(Number(v.amount) > 0)}
              onClick={() => record.mutate()}
            >
              Record payment
            </Button>
          </>
        }
      >
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (Number(v.amount) > 0) record.mutate();
          }}
        >
          <Field label="Amount" required error={errors.amount}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0.01}
                max={invoice.balanceDue}
                value={v.amount}
                onChange={(e) => setV({ ...v, amount: e.target.value })}
                autoFocus
              />
            )}
          </Field>
          <Field label="Paid on" error={errors.paidOn}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={v.paidOn}
                onChange={(e) => setV({ ...v, paidOn: e.target.value })}
              />
            )}
          </Field>
          <Field label="Method">
            {(p) => (
              <NativeSelect
                {...p}
                value={v.method}
                onChange={(e) => setV({ ...v, method: e.target.value as Payment['method'] })}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Reference" help="Optional. Transaction or cheque number.">
            {(p) => (
              <Input {...p} value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} />
            )}
          </Field>
          {record.error && !Object.keys(errors).length ? (
            <p role="alert" className="text-sm text-accent sm:col-span-2">
              {record.error.message}
            </p>
          ) : null}
          <button type="submit" hidden />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VoidDialog({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const voidIt = useMutation({
    mutationFn: () => apiPost(`${BASE}/${invoice.uuid}/void`, { reason }),
    onSuccess: () => {
      toast.success('Voided');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={`Void ${invoice.number}`}
        description="The invoice stays on record with its number, marked as void. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={voidIt.isPending}
              disabled={!reason.trim()}
              onClick={() => voidIt.mutate()}
            >
              Void
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
        </Field>
        {voidIt.error ? (
          <p role="alert" className="mt-2 text-sm text-accent">
            {voidIt.error.message}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PaymentsPane({ invoice }: { invoice: Invoice }) {
  const can = useCan();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (p: Payment) => apiDelete(`${BASE}/${invoice.uuid}/payments/${p.uuid}`),
    onSuccess: () => {
      toast.success('Payment removed');
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const payments = invoice.payments ?? [];
  if (invoice.status === 'draft') return null;
  return (
    <Pane title="Payments" className="mx-auto mb-4 max-w-4xl print:hidden" padded={!payments.length}>
      {payments.length ? (
        <ul>
          {payments.map((p) => (
            <li
              key={p.uuid}
              className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0"
            >
              <CreditCard className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="font-medium tabular-nums">
                  {formatMoney(p.amount, invoice.currency, true)}
                </span>
                <span className="text-muted">
                  {' '}
                  · {METHOD_LABEL[p.method]} · {formatDate(p.paidOn)}
                  {p.reference ? ` · ${p.reference}` : ''}
                </span>
              </span>
              {can('invoices.payments.manage') ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm('Remove this payment? The balance due goes back up.'))
                      remove.mutate(p);
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No payments yet.</p>
      )}
    </Pane>
  );
}

function InvoiceDetail() {
  const { uuid = '' } = useParams();
  const nav = useNavigate();
  const can = useCan();
  const boot = useBoot();
  const qc = useQueryClient();
  const nouns = useNouns();
  const invoice = useInvoice(uuid);
  const [dialog, setDialog] = useState<'pay' | 'void' | null>(null);
  const issue = useMutation({
    mutationFn: () => apiPost(`${BASE}/${uuid}/issue`),
    onSuccess: () => {
      toast.success('Issued');
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast.error(e.message),
  });
  const duplicate = useMutation({
    mutationFn: () => apiPost<Invoice>(`${BASE}/${uuid}/duplicate`),
    onSuccess: (inv) => {
      toast.success('Duplicated');
      void qc.invalidateQueries({ queryKey: KEY });
      nav(`${ROOT}/${inv.uuid}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`${BASE}/${uuid}`),
    onSuccess: () => {
      toast.success('Deleted');
      void qc.invalidateQueries({ queryKey: KEY });
      nav(ROOT);
    },
  });

  if (invoice.isPending)
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Skeleton className="h-[600px]" />
      </div>
    );
  if (invoice.isError) return <ErrorState error={invoice.error} onRetry={() => void invoice.refetch()} />;
  const inv = invoice.data;
  const update = can('invoices.invoices.update');
  const open = inv.status === 'issued' || inv.status === 'partially_paid';

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{inv.number}</span> <InvoiceStatus invoice={inv} />
          </span>
        }
        description={
          inv.deal ? (
            <>
              {labelVars(boot.labels).deal}:{' '}
              <Link to={`/deals/${inv.deal.uuid}`} className="text-primary hover:underline">
                {inv.deal.name}
              </Link>
            </>
          ) : (
            inv.title || undefined
          )
        }
        actions={
          <>
            {update && inv.status === 'draft' ? (
              <>
                <Button asChild>
                  <Link to={`${ROOT}/${inv.uuid}/edit`}>
                    <Pencil /> Edit
                  </Link>
                </Button>
                <Button variant="primary" loading={issue.isPending} onClick={() => issue.mutate()}>
                  <Send /> Issue
                </Button>
              </>
            ) : null}
            {open && can('invoices.payments.manage') ? (
              <Button variant="primary" onClick={() => setDialog('pay')}>
                <CreditCard /> Record payment
              </Button>
            ) : null}
            {open && update && inv.amountPaid === 0 ? (
              <Button variant="ghost" onClick={() => setDialog('void')}>
                <Ban /> Void
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {can('invoices.invoices.create') ? (
              <Button variant="ghost" size="icon" aria-label="Duplicate" onClick={() => duplicate.mutate()}>
                <Copy />
              </Button>
            ) : null}
            {can('invoices.invoices.delete') && inv.status === 'draft' ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete"
                onClick={() => {
                  if (window.confirm(`Delete draft ${inv.number}?`)) remove.mutate();
                }}
              >
                <Trash2 />
              </Button>
            ) : null}
          </>
        }
      />
      <div className="p-4 md:p-6 print:p-0">
        {inv.status === 'void' ? (
          <p className="mx-auto mb-4 max-w-4xl rounded-md border border-line bg-subtle px-4 py-2 text-sm print:hidden">
            Voided{inv.voidReason ? `: ${inv.voidReason}` : ''}
          </p>
        ) : null}
        {inv.sourceQuoteUuid && boot.modules.enabled.includes('quotes') ? (
          <p className="mx-auto mb-4 max-w-4xl text-sm text-muted print:hidden">
            Created from{' '}
            <Link to={`/m/quotes/${inv.sourceQuoteUuid}`} className="text-primary hover:underline">
              an accepted quote
            </Link>
            .
          </p>
        ) : null}
        <PaymentsPane invoice={inv} />
        <DocumentPaper
          kind={nouns.one}
          business={boot.settings.commerce}
          partyLabel="Billed to"
          number={inv.number}
          title={inv.title}
          organization={inv.organization}
          contact={inv.contact}
          dates={[
            { label: 'Issued', value: inv.issueDate },
            { label: 'Due', value: inv.dueDate },
          ]}
          currency={inv.currency}
          lines={inv.lines ?? []}
          extraTotals={
            inv.status === 'draft' || inv.status === 'void'
              ? undefined
              : [
                  { label: 'Paid', value: -inv.amountPaid },
                  { label: 'Balance due', value: inv.balanceDue, strong: true },
                ]
          }
          notes={inv.notes}
          terms={inv.terms}
          footer={
            inv.paymentInstructions ? (
              <div className="sm:col-span-2">
                <p className="text-xs font-medium tracking-wide text-muted uppercase">How to pay</p>
                <p className="mt-1 whitespace-pre-line">{inv.paymentInstructions}</p>
              </div>
            ) : null
          }
        />
      </div>
      {dialog === 'pay' ? <PaymentDialog invoice={inv} onDone={() => setDialog(null)} /> : null}
      {dialog === 'void' ? <VoidDialog invoice={inv} onDone={() => setDialog(null)} /> : null}
    </div>
  );
}

interface Receivables {
  totals: { currency: string; outstanding: number; overdue: number; count: number; overdueCount: number }[];
}

function ReceivablesWidget({ data }: { data: unknown }) {
  const { totals } = data as Receivables;
  if (!totals.length)
    return <p className="flex flex-1 items-center justify-center text-sm text-muted">Nothing outstanding.</p>;
  return (
    <div className="flex flex-1 flex-col gap-4">
      {totals.map((t) => (
        <dl key={t.currency} className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs text-muted">Outstanding ({t.count})</dt>
            <dd className="text-2xl font-semibold tracking-tight tabular-nums">
              {formatMoney(t.outstanding, t.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Overdue ({t.overdueCount})</dt>
            <dd
              className={`text-2xl font-semibold tracking-tight tabular-nums ${t.overdue ? 'text-accent' : ''}`}
            >
              {formatMoney(t.overdue, t.currency)}
            </dd>
          </div>
        </dl>
      ))}
      <Link to={`${ROOT}?status=overdue`} className="mt-auto text-sm text-primary hover:underline">
        See overdue invoices
      </Link>
    </div>
  );
}

const invoicesModule: WebModule = {
  key: 'invoices',
  routes: [
    { path: '', element: <InvoicesList /> },
    { path: 'new', element: <InvoiceEditor /> },
    { path: ':uuid', element: <InvoiceDetail /> },
    { path: ':uuid/edit', element: <InvoiceEditor /> },
  ],
  widgets: { 'invoices.receivables': (p) => <ReceivablesWidget data={p.data} /> },
};

export default invoicesModule;
