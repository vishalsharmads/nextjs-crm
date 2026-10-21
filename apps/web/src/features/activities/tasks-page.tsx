import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckSquare } from 'lucide-react';
import type { ActivityDto, ListResponse } from '@app/shared';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useBranding } from '@/app/branding';
import { useT } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { ActivityItem } from './activity-components';

type Tab = 'open' | 'overdue' | 'done';

/** "My work": tasks, calls and meetings assigned to me, overdue first. */
export function TasksPage() {
  const t = useT();
  const { branding } = useBranding();
  const [tab, setTab] = useState<Tab>('open');
  useEffect(() => setDocumentTitle(t('nav.tasks'), branding.appName), [t, branding.appName]);
  const now = new Date().toISOString();
  const conditions = [
    { field: 'assignee', op: 'in', value: ['@me'] },
    { field: 'type', op: 'nin', value: ['note'] },
    { field: 'completed', op: 'eq', value: tab === 'done' },
    ...(tab === 'overdue' ? [{ field: 'due_at', op: 'lt', value: now }] : []),
  ];
  const q = useQuery({
    queryKey: ['records', 'activities', 'list', 'mine', tab],
    queryFn: () =>
      apiGet<ListResponse<ActivityDto>>('/activities', {
        filter: JSON.stringify({ and: conditions }),
        sort: tab === 'done' ? '-completed_at' : 'due_at',
        pageSize: 100,
      }),
  });
  const tabs: [Tab, string][] = [
    ['open', 'Open'],
    ['overdue', 'Overdue'],
    ['done', 'Done'],
  ];
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('nav.tasks')}>
        <div role="tablist" className="flex gap-1">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm',
                tab === k ? 'border-primary font-medium' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-4 md:px-6">
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.data.length ? (
          <EmptyState
            icon={<CheckSquare />}
            title={tab === 'done' ? 'Nothing completed yet' : 'You are all caught up'}
            description={tab === 'done' ? undefined : 'New tasks you are assigned will show up here.'}
          />
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface px-4">
            {q.data.data.map((a) => (
              <ActivityItem key={a.uuid} a={a} showRelated />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
