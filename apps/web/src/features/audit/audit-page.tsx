import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { SettingsPage } from '@/features/settings/layout';

interface Entry {
  id: number;
  action: string;
  entity: string;
  entityUuid: string | null;
  actor: { uuid: string; name: string } | null;
  actorType: string;
  diff: unknown;
  ip: string | null;
  createdAt: string;
}

export function AuditPage() {
  const t = useT();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['audit', page, action],
    queryFn: () =>
      apiGet<{ data: Entry[]; meta: { total: number; pageSize: number } }>('/audit-logs', {
        page,
        action: action || undefined,
      }),
    placeholderData: keepPreviousData,
  });
  return (
    <SettingsPage
      title={t('settings.audit')}
      description="Every change, sign-in and export, newest first. Entries cannot be edited or deleted."
    >
      <Input
        value={action}
        onChange={(e) => (setAction(e.target.value), setPage(1))}
        placeholder="Filter by action, e.g. contact. or auth.login"
        className="max-w-sm"
        aria-label="Filter by action"
      />
      <Pane padded={false}>
        {q.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <ul className="divide-y divide-line">
            {q.data.data.map((e) => (
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
                  <span className="min-w-28 font-medium">
                    {e.actor?.name ?? (e.actorType === 'cli' ? 'Command line' : 'System')}
                  </span>
                  <Badge tone="outline">{e.action}</Badge>
                  {e.ip ? <span className="ms-auto text-xs text-faint">{e.ip}</span> : null}
                </button>
                {open === e.id && e.diff ? (
                  <pre className="overflow-x-auto bg-subtle px-4 py-3 text-xs">
                    {JSON.stringify(e.diff, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {q.data ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted">
          Page {page} of {Math.max(1, Math.ceil(q.data.meta.total / q.data.meta.pageSize))}
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
    </SettingsPage>
  );
}
