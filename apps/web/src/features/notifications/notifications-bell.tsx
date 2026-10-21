import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';

interface Note {
  uuid: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export function NotificationsBell() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const count = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: () => apiGet<{ count: number }>('/notifications/unread-count').then((r) => r.count),
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => apiGet<{ data: Note[] }>('/notifications').then((r) => r.data),
    enabled: false,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['notifications'] });
  const read = useMutation({
    mutationFn: (uuid: string) => apiPost(`/notifications/${uuid}/read`),
    onSuccess: refresh,
  });
  const readAll = useMutation({ mutationFn: () => apiPost('/notifications/read-all'), onSuccess: refresh });
  const unread = count.data ?? 0;
  return (
    <Popover onOpenChange={(o) => o && void list.refetch()}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label={unread ? `${t('nav.notifications')}: ${unread} unread` : t('nav.notifications')}
          className="relative"
        >
          <Bell />
          {unread ? (
            <span className="absolute end-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-accent-fg tabular">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <p className="text-sm font-semibold">{t('nav.notifications')}</p>
          {unread ? (
            <Button size="sm" variant="ghost" onClick={() => readAll.mutate()}>
              Mark all read
            </Button>
          ) : null}
        </div>
        <ul className="max-h-96 divide-y divide-line overflow-y-auto">
          {list.data?.length ? (
            list.data.map((n) => (
              <li key={n.uuid}>
                <button
                  type="button"
                  onClick={() => {
                    if (!n.readAt) read.mutate(n.uuid);
                    if (n.link) navigate(n.link);
                  }}
                  className="flex w-full gap-2 px-3 py-2.5 text-start hover:bg-hover"
                >
                  <span
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      n.readAt ? 'bg-transparent' : 'bg-primary',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className={cn('block text-sm', !n.readAt && 'font-medium')}>{n.title}</span>
                    {n.body ? <span className="block truncate text-xs text-muted">{n.body}</span> : null}
                    <span className="block text-2xs text-faint">{formatRelative(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-8 text-center text-sm text-muted">
              {list.isFetching ? 'Loading…' : 'You are all caught up.'}
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
