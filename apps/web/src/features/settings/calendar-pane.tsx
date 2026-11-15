import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, RefreshCw } from 'lucide-react';
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { confirmAction } from '@/components/ui/confirm';

interface CalendarAccount {
  uuid: string;
  url: string;
  username: string;
  displayName: string;
  lastSyncAt: string | null;
  lastError: string | null;
}

/** Profile → Calendar: a CalDAV calendar kept in step both ways, and a private feed address. */
export function CalendarPane() {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ['calendar-accounts'],
    queryFn: () => apiGet<{ data: CalendarAccount[] }>('/calendar/accounts').then((r) => r.data),
  });
  const feed = useQuery({
    queryKey: ['calendar-feed'],
    queryFn: () => apiGet<{ active: boolean }>('/me/calendar-feed'),
  });
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [form, setForm] = useState({ url: '', username: '', password: '' });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['calendar-accounts'] });
  const connect = useMutation({
    mutationFn: () => apiPost('/calendar/accounts', form),
    onSuccess: () => {
      toast.success('Calendar connected');
      setForm({ url: '', username: '', password: '' });
      refresh();
    },
  });
  const sync = useMutation({
    mutationFn: (uuid: string) =>
      apiPost<{ logged: number; updated: number }>(`/calendar/accounts/${uuid}/sync`),
    onSuccess: (r) => {
      toast.success(`Synced: ${r.logged} new, ${r.updated} updated`);
      refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/calendar/accounts/${uuid}`),
    onSuccess: () => {
      toast.success('Disconnected');
      refresh();
    },
  });
  const makeFeed = useMutation({
    mutationFn: () => apiPost<{ url: string }>('/me/calendar-feed'),
    onSuccess: (r) => {
      setFeedUrl(r.url);
      void qc.invalidateQueries({ queryKey: ['calendar-feed'] });
    },
  });
  const removeFeed = useMutation({
    mutationFn: () => apiDelete('/me/calendar-feed'),
    onSuccess: () => {
      setFeedUrl(null);
      toast.success('Removed');
      void qc.invalidateQueries({ queryKey: ['calendar-feed'] });
    },
  });
  const account = accounts.data?.[0];
  return (
    <Pane title="Calendar">
      <div className="flex flex-col gap-5">
        <section>
          <h3 className="text-sm font-medium">Your calendar</h3>
          <p className="mb-2 text-sm text-muted">
            Connect one calendar by its CalDAV address. Events with people you know here become meetings, and
            meetings you add here appear there. Use an app password if your provider asks for one.
          </p>
          {accounts.isPending ? (
            <Skeleton className="h-12" />
          ) : accounts.isError ? (
            <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
          ) : account ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{account.displayName || account.url}</p>
                <p className="text-xs text-muted">
                  {account.lastSyncAt ? `Synced ${formatRelative(account.lastSyncAt)}` : 'Not synced yet'}
                </p>
                {account.lastError ? <p className="text-xs text-accent">{account.lastError}</p> : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => sync.mutate(account.uuid)}
                loading={sync.isPending}
              >
                <RefreshCw /> Sync now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void confirmAction({
                    title: 'Disconnect this calendar?',
                    action: 'Disconnect',
                    danger: true,
                  }).then((ok) => ok && disconnect.mutate(account.uuid))
                }
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <form
              className="grid gap-3 sm:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                connect.mutate();
              }}
            >
              <Field label="Calendar address (CalDAV)" className="sm:col-span-3">
                {(p) => (
                  <Input
                    {...p}
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="https://"
                  />
                )}
              </Field>
              <Field label="User name">
                {(p) => (
                  <Input
                    {...p}
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Password">
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                )}
              </Field>
              <div className="flex items-end">
                <Button
                  type="submit"
                  loading={connect.isPending}
                  disabled={!form.url || !form.username || !form.password}
                >
                  Connect
                </Button>
              </div>
            </form>
          )}
        </section>
        <section className="border-t border-line pt-4">
          <h3 className="text-sm font-medium">Subscribe from another calendar</h3>
          <p className="mb-2 text-sm text-muted">
            A private address of your meetings and tasks with a time, for calendar apps that subscribe to a
            web address. Anyone with it can see their titles and times: replace it if it is shared by mistake.
          </p>
          {feedUrl ? (
            <div className="mb-2 flex items-center gap-2">
              <Input
                readOnly
                value={feedUrl}
                aria-label="Calendar feed address"
                onFocus={(e) => e.target.select()}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label="Copy address"
                onClick={() =>
                  void navigator.clipboard.writeText(feedUrl).then(() => toast.success('Copied'))
                }
              >
                <Copy />
              </Button>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => makeFeed.mutate()} loading={makeFeed.isPending}>
              {feed.data?.active ? 'Replace address' : 'Create address'}
            </Button>
            {feed.data?.active ? (
              <Button size="sm" variant="ghost" onClick={() => removeFeed.mutate()}>
                Remove
              </Button>
            ) : null}
          </div>
        </section>
      </div>
    </Pane>
  );
}
