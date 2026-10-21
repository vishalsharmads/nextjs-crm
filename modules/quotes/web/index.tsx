import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, FileText, Pencil, Plus, Printer, Search, Send, Trash2, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { WebModule } from '@app/module-sdk';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { DocumentPaper, type RecordRef } from '@/components/commerce/document-paper';
import {
  DocumentForm,
  emptyDocument,
  toDocumentBody,
  type DocumentFormValues,
} from '@/components/commerce/document-form';
import { toEditable, type LineDto } from '@/components/commerce/line-items';

type Status = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';

interface Quote {
  uuid: string;
  number: string;
  title: string;
  status: Status;
  issueDate: string;
  validUntil: string | null;
  currency: string;
  contact: RecordRef | null;
  organization: RecordRef | null;
  deal: RecordRef | null;
  owner: { uuid: string; name: string } | null;
  total: number;
  notes: string | null;
  terms: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  acceptedByName: string | null;
  declineReason: string | null;
  convertedInvoiceUuid: string | null;
  lines?: LineDto[];
}

const BASE = '/m/quotes/quotes';
const KEY = ['m', 'quotes'] as const;
const STATUS_LABEL: Record<Status, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
};

export function QuoteStatus({ status }: { status: Status }) {
  const tone =
    status === 'accepted'
      ? 'primary'
      : status === 'declined'
        ? 'accent'
        : status === 'sent'
          ? 'outline'
          : 'neutral';
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>;
}

function useQuoteNouns() {
  const L = labelVars(useBoot().labels);
  return { one: L.quote ?? 'Quote', many: L.quotePlural ?? 'Quotes' };
}

function QuotesList() {
  const can = useCan();
  const nouns = useQuoteNouns();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as Status | '';
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: [...KEY, 'list', status, q],
    queryFn: () =>
      apiGet<{ data: Quote[]; meta: { total: number } }>(BASE, {
        status: status || undefined,
        q,
        pageSize: 100,
      }),
    placeholderData: keepPreviousData,
  });
  const tabs: [Status | '', string][] = [
    ['', 'All'],
    ...(Object.entries(STATUS_LABEL) as [Status, string][]),
  ];
  return (
    <div>
      <PageHeader
        title={nouns.many}
        actions={
          can('quotes.quotes.create') ? (
            <Button variant="primary" asChild>
              <Link to="/m/quotes/new">
                <Plus /> New {nouns.one.toLowerCase()}
              </Link>
            </Button>
          ) : null
        }
      >
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Filter by status">
          {tabs.map(([key, label]) => (
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
            icon={<FileText />}
            title={
              q || status ? `No ${nouns.many.toLowerCase()} match` : `No ${nouns.many.toLowerCase()} yet`
            }
            description={
              !q && !status ? 'Put together a priced proposal and send it when it is ready.' : undefined
            }
            action={
              !q && !status && can('quotes.quotes.create') ? (
                <Button variant="primary" asChild>
                  <Link to="/m/quotes/new">
                    <Plus /> New {nouns.one.toLowerCase()}
                  </Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-line bg-subtle text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">Number</th>
                  <th className="px-4 py-2 text-start font-medium">For</th>
                  <th className="px-4 py-2 text-start font-medium">Status</th>
                  <th className="px-4 py-2 text-start font-medium">Valid until</th>
                  <th className="px-4 py-2 text-end font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {list.data.data.map((x) => (
                  <tr key={x.uuid} className="border-b border-line last:border-0 hover:bg-hover">
                    <td className="px-4 py-2.5">
                      <Link to={`/m/quotes/${x.uuid}`} className="font-mono font-medium hover:underline">
                        {x.number}
                      </Link>
                      {x.title ? <p className="line-clamp-1 text-xs text-muted">{x.title}</p> : null}
                    </td>
                    <td className="px-4 py-2.5">{x.organization?.name ?? x.contact?.name ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <QuoteStatus status={x.status} />
                    </td>
                    <td className="px-4 py-2.5 text-muted">{formatDate(x.validUntil)}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums">{formatMoney(x.total, x.currency)}</td>
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
  { key: 'validUntil', label: 'Valid until', help: 'Defaults from your settings.' },
];

function useQuote(uuid: string) {
  return useQuery({
    queryKey: [...KEY, 'one', uuid],
    queryFn: () => apiGet<Quote>(`${BASE}/${uuid}`),
    enabled: !!uuid,
  });
}

function QuoteEditor() {
  const { uuid } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const boot = useBoot();
  const nouns = useQuoteNouns();
  const [search] = useSearchParams();
  const existing = useQuote(uuid ?? '');
  const save = useMutation({
    mutationFn: (v: DocumentFormValues) =>
      uuid ? apiPatch<Quote>(`${BASE}/${uuid}`, toDocumentBody(v)) : apiPost<Quote>(BASE, toDocumentBody(v)),
    onSuccess: (q) => {
      toast.success(uuid ? `${nouns.one} saved` : `${nouns.one} created`);
      void qc.invalidateQueries({ queryKey: KEY });
      nav(`/m/quotes/${q.uuid}`, { replace: true });
    },
  });
  if (uuid && existing.isPending) return <Skeleton className="m-6 h-96" />;
  if (uuid && existing.isError) return <ErrorState error={existing.error} />;
  const q = existing.data;
  const initial: DocumentFormValues = q
    ? {
        title: q.title,
        organization: q.organization,
        contact: q.contact,
        deal: q.deal,
        currency: q.currency,
        dates: { issueDate: q.issueDate, validUntil: q.validUntil ?? '' },
        notes: q.notes ?? '',
        terms: q.terms ?? '',
        lines: toEditable(q.lines ?? []),
      }
    : {
        ...emptyDocument(boot.settings.general.currency, boot.settings.commerce.defaultTaxRate),
        // "New quote" from a deal page arrives with the deal prefilled.
        deal: search.get('dealUuid')
          ? { uuid: search.get('dealUuid')!, name: search.get('dealName') ?? '' }
          : null,
        organization: search.get('organizationUuid')
          ? { uuid: search.get('organizationUuid')!, name: search.get('organizationName') ?? '' }
          : null,
      };
  return (
    <div>
      <PageHeader title={q ? `Edit ${q.number}` : `New ${nouns.one.toLowerCase()}`} />
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        <DocumentForm
          initial={initial}
          dateFields={DATE_FIELDS}
          submitLabel={q ? 'Save changes' : `Create ${nouns.one.toLowerCase()}`}
          submitting={save.isPending}
          error={save.error}
          onSubmit={(v) => save.mutate(v)}
          onCancel={() => nav(q ? `/m/quotes/${q.uuid}` : '/m/quotes')}
        />
      </div>
    </div>
  );
}

function AcceptDialog({ quote, onDone }: { quote: Quote; onDone: () => void }) {
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: () => apiPost(`${BASE}/${quote.uuid}/accept`, { acceptedByName: name || null }),
    onSuccess: () => {
      toast.success('Marked as accepted');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title="Mark as accepted"
        description="Use this when the customer accepted outside the app, for example by signing a copy."
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button variant="primary" loading={accept.isPending} onClick={() => accept.mutate()}>
              Mark as accepted
            </Button>
          </>
        }
      >
        <Field label="Accepted by" help="Optional. The name of the person who accepted.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
      </DialogContent>
    </Dialog>
  );
}

function DeclineDialog({ quote, onDone }: { quote: Quote; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const qc = useQueryClient();
  const decline = useMutation({
    mutationFn: () => apiPost(`${BASE}/${quote.uuid}/decline`, { reason: reason || null }),
    onSuccess: () => {
      toast.success('Marked as declined');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title="Mark as declined"
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button variant="danger" loading={decline.isPending} onClick={() => decline.mutate()}>
              Mark as declined
            </Button>
          </>
        }
      >
        <Field label="Reason" help="Optional. Helps you see why quotes are lost.">
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
        </Field>
      </DialogContent>
    </Dialog>
  );
}

function QuoteDetail() {
  const { uuid = '' } = useParams();
  const nav = useNavigate();
  const can = useCan();
  const boot = useBoot();
  const qc = useQueryClient();
  const nouns = useQuoteNouns();
  const quote = useQuote(uuid);
  const [dialog, setDialog] = useState<'accept' | 'decline' | null>(null);
  const done = (verb: string) => () => {
    toast.success(verb);
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const send = useMutation({
    mutationFn: () => apiPost(`${BASE}/${uuid}/send`),
    onSuccess: done('Marked as sent'),
  });
  const revise = useMutation({
    mutationFn: () => apiPost(`${BASE}/${uuid}/revise`),
    onSuccess: done('Moved back to draft'),
  });
  const duplicate = useMutation({
    mutationFn: () => apiPost<Quote>(`${BASE}/${uuid}/duplicate`),
    onSuccess: (q) => {
      toast.success('Duplicated');
      void qc.invalidateQueries({ queryKey: KEY });
      nav(`/m/quotes/${q.uuid}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`${BASE}/${uuid}`),
    onSuccess: () => {
      toast.success('Deleted');
      void qc.invalidateQueries({ queryKey: KEY });
      nav('/m/quotes');
    },
  });
  const convert = useMutation({
    mutationFn: () => apiPost<{ uuid: string }>(`/m/invoices/invoices/from-quote/${uuid}`),
    onSuccess: (inv) => {
      toast.success('Invoice created');
      void qc.invalidateQueries({ queryKey: KEY });
      nav(`/m/invoices/${inv.uuid}`);
    },
  });

  if (quote.isPending)
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Skeleton className="h-[600px]" />
      </div>
    );
  if (quote.isError) return <ErrorState error={quote.error} onRetry={() => void quote.refetch()} />;
  const q = quote.data;
  const update = can('quotes.quotes.update');
  const busy = send.isPending || revise.isPending;
  const invoicesOn = boot.modules.enabled.includes('invoices') && can('invoices.invoices.create');

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{q.number}</span> <QuoteStatus status={q.status} />
          </span>
        }
        description={
          q.deal ? (
            <>
              {labelVars(boot.labels).deal}:{' '}
              <Link to={`/deals/${q.deal.uuid}`} className="text-primary hover:underline">
                {q.deal.name}
              </Link>
            </>
          ) : (
            q.title || undefined
          )
        }
        actions={
          <>
            {update && q.status === 'draft' ? (
              <>
                <Button asChild>
                  <Link to={`/m/quotes/${q.uuid}/edit`}>
                    <Pencil /> Edit
                  </Link>
                </Button>
                <Button
                  variant="primary"
                  loading={send.isPending}
                  disabled={busy}
                  onClick={() => send.mutate()}
                >
                  <Send /> Mark as sent
                </Button>
              </>
            ) : null}
            {update && (q.status === 'sent' || q.status === 'expired') ? (
              <>
                <Button onClick={() => setDialog('decline')}>
                  <X /> Declined
                </Button>
                <Button variant="primary" onClick={() => setDialog('accept')}>
                  <Check /> Accepted
                </Button>
              </>
            ) : null}
            {update && ['sent', 'declined', 'expired'].includes(q.status) ? (
              <Button variant="ghost" loading={revise.isPending} onClick={() => revise.mutate()}>
                <Undo2 /> Revise
              </Button>
            ) : null}
            {q.status === 'accepted' && invoicesOn ? (
              q.convertedInvoiceUuid ? (
                <Button asChild>
                  <Link to={`/m/invoices/${q.convertedInvoiceUuid}`}>View invoice</Link>
                </Button>
              ) : (
                <Button variant="primary" loading={convert.isPending} onClick={() => convert.mutate()}>
                  Create invoice
                </Button>
              )
            ) : null}
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {can('quotes.quotes.create') ? (
              <Button variant="ghost" size="icon" aria-label="Duplicate" onClick={() => duplicate.mutate()}>
                <Copy />
              </Button>
            ) : null}
            {can('quotes.quotes.delete') && q.status !== 'accepted' ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete"
                onClick={() => {
                  if (window.confirm(`Delete ${q.number}? This cannot be undone.`)) remove.mutate();
                }}
              >
                <Trash2 />
              </Button>
            ) : null}
          </>
        }
      />
      <div className="p-4 md:p-6 print:p-0">
        {q.status === 'declined' && q.declineReason ? (
          <p className="mx-auto mb-4 max-w-4xl rounded-md border border-line bg-accent-soft px-4 py-2 text-sm print:hidden">
            Declined: {q.declineReason}
          </p>
        ) : null}
        {q.status === 'accepted' ? (
          <p className="mx-auto mb-4 max-w-4xl rounded-md border border-line bg-primary-soft px-4 py-2 text-sm print:hidden">
            Accepted{q.acceptedByName ? ` by ${q.acceptedByName}` : ''} on {formatDate(q.respondedAt)}.
          </p>
        ) : null}
        <DocumentPaper
          kind={nouns.one}
          number={q.number}
          title={q.title}
          organization={q.organization}
          contact={q.contact}
          dates={[
            { label: 'Issued', value: q.issueDate },
            { label: 'Valid until', value: q.validUntil },
          ]}
          currency={q.currency}
          lines={q.lines ?? []}
          notes={q.notes}
          terms={q.terms}
        />
      </div>
      {dialog === 'accept' ? <AcceptDialog quote={q} onDone={() => setDialog(null)} /> : null}
      {dialog === 'decline' ? <DeclineDialog quote={q} onDone={() => setDialog(null)} /> : null}
    </div>
  );
}

const quotesModule: WebModule = {
  key: 'quotes',
  routes: [
    { path: '', element: <QuotesList /> },
    { path: 'new', element: <QuoteEditor /> },
    { path: ':uuid', element: <QuoteDetail /> },
    { path: ':uuid/edit', element: <QuoteEditor /> },
  ],
};

export default quotesModule;
