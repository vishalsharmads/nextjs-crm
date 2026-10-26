import { useState } from 'react';
import { useMutation, useQuery, keepPreviousData } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiPost, buildUrl } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useCan, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import {
  Badge,
  EmptyState,
  ErrorState,
  Pane,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/misc';
import { SettingsPage } from '@/features/settings/layout';

interface Entry {
  id: number;
  action: string;
  entity: string;
  entityUuid: string | null;
  actor: { uuid: string; name: string } | null;
  actorType: string;
  diff?: unknown;
  detail?: unknown;
  ip: string | null;
  createdAt: string;
}

interface Filters {
  action: string;
  entity: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { action: '', entity: '', from: '', to: '' };

/** Date inputs give local calendar days; the API takes instants. */
function toQuery(f: Filters) {
  return {
    action: f.action || undefined,
    entity: f.entity || undefined,
    from: f.from ? new Date(`${f.from}T00:00:00`).toISOString() : undefined,
    to: f.to ? new Date(`${f.to}T23:59:59.999`).toISOString() : undefined,
  };
}

const actorLabel = (e: Entry) => e.actor?.name ?? (e.actorType === 'cli' ? 'Command line' : 'System');

export function AuditPage() {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = useState<'changes' | 'access'>('changes');
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const verify = useMutation({
    mutationFn: () =>
      apiPost<{
        daysChecked: number;
        problems: { day: string; source: string }[];
        sealedThrough: string | null;
      }>('/audit-logs/verify'),
    onSuccess: (r) =>
      r.problems.length
        ? toast.error(
            `Integrity check failed for ${r.problems.length} day(s), starting ${r.problems[0]!.day}. Restore from backup and investigate.`,
          )
        : toast.success(
            r.daysChecked
              ? `Verified ${r.daysChecked} sealed day(s), through ${r.sealedThrough}. No changes found.`
              : 'No sealed days yet. Days are sealed once they end (UTC).',
          ),
  });
  const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const endpoint = tab === 'changes' ? '/audit-logs' : '/access-logs';

  return (
    <SettingsPage
      title={t('settings.audit')}
      description="Every change, sign-in and export, newest first, plus who viewed and downloaded records when access logging is on. Entries cannot be edited or deleted."
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => verify.mutate()} loading={verify.isPending}>
            <ShieldCheck /> Check integrity
          </Button>
          {can('core.audit.export') ? (
            <Button asChild variant="secondary">
              <a href={buildUrl(`${endpoint}/export`, toQuery(filters))} download>
                <Download /> Export CSV
              </a>
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Action starts with">
          {(p) => (
            <Input
              {...p}
              value={filters.action}
              onChange={(e) => set('action', e.target.value)}
              placeholder={tab === 'changes' ? 'auth.login' : 'view'}
            />
          )}
        </Field>
        <Field label="Record type">
          {(p) => (
            <Input
              {...p}
              value={filters.entity}
              onChange={(e) => set('entity', e.target.value)}
              placeholder="contact"
            />
          )}
        </Field>
        <Field label="From">
          {(p) => (
            <Input {...p} type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          )}
        </Field>
        <Field label="To">
          {(p) => <Input {...p} type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />}
        </Field>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
        </TabsList>
        <TabsContent value="changes" className="pt-4">
          <LogList endpoint="/audit-logs" filters={filters} body={(e) => e.diff} />
        </TabsContent>
        <TabsContent value="access" className="pt-4">
          <LogList endpoint="/access-logs" filters={filters} body={(e) => e.detail} />
        </TabsContent>
      </Tabs>
    </SettingsPage>
  );
}

function LogList({
  endpoint,
  filters,
  body,
}: {
  endpoint: string;
  filters: Filters;
  body: (e: Entry) => unknown;
}) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const query = toQuery(filters);
  const q = useQuery({
    queryKey: ['audit', endpoint, page, query],
    queryFn: () =>
      apiGet<{ data: Entry[]; meta: { total: number; pageSize: number } }>(endpoint, { page, ...query }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="flex flex-col gap-3">
      <Pane padded={false}>
        {q.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.data.length ? (
          <EmptyState
            title="Nothing matches"
            description={
              endpoint === '/access-logs'
                ? 'Turn on access logging under Settings → Compliance to record who views and downloads records.'
                : 'Try a wider date range or clear the filters.'
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {q.data.data.map((e) => {
              const extra = body(e);
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(open === e.id ? null : e.id)}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-start text-sm hover:bg-hover"
                    aria-expanded={open === e.id}
                  >
                    <time className="w-36 shrink-0 text-xs text-muted tabular">
                      {formatDateTime(e.createdAt)}
                    </time>
                    <span className="min-w-28 font-medium">{actorLabel(e)}</span>
                    <Badge tone="outline">{e.action}</Badge>
                    <span className="text-xs text-muted">{e.entity}</span>
                    {e.ip ? <span className="ms-auto text-xs text-faint">{e.ip}</span> : null}
                  </button>
                  {open === e.id && extra ? (
                    <pre className="overflow-x-auto bg-subtle px-4 py-3 text-xs">
                      {JSON.stringify(extra, null, 2)}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Pane>
      {q.data && q.data.meta.total > q.data.meta.pageSize ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted">
          Page {page} of {Math.ceil(q.data.meta.total / q.data.meta.pageSize)}
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="rtl:-scale-x-100" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={page * q.data.meta.pageSize >= q.data.meta.total}
            onClick={() => setPage(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="rtl:-scale-x-100" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
