import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { ApiError, apiGet, apiPost } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ErrorState, Pane, Skeleton } from '@/components/ui/misc';

interface Info {
  appName: string;
  client: { name: string; redirectHost: string };
  wantsFull: boolean;
}

/**
 * The approval page an MCP client sends a person to (OAuth authorization endpoint). They are
 * signed in by the app shell first, then choose what the client may do, or decline.
 */
export function OAuthAuthorizePage() {
  const [params] = useSearchParams();
  const query = Object.fromEntries(params.entries());
  const info = useQuery({
    queryKey: ['oauth', 'authorize', query],
    queryFn: () => apiGet<Info>('/oauth/authorize/info', query),
    retry: false,
  });
  const [access, setAccess] = useState<'read' | 'full' | null>(null);
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      apiPost<{ redirect: string }>('/oauth/authorize', {
        ...query,
        access: access ?? (info.data?.wantsFull ? 'full' : 'read'),
        approve,
      }),
    // The client is waiting at its redirect address; leaving the app is the point.
    onSuccess: (r) => window.location.assign(r.redirect),
  });
  if (info.isPending) return <Skeleton className="m-6 h-48" />;
  if (info.isError)
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorState
          error={
            info.error instanceof ApiError
              ? info.error
              : new Error('This request to connect an AI client is not valid.')
          }
        />
      </div>
    );
  const chosen = access ?? (info.data.wantsFull ? 'full' : 'read');
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <Pane>
        <div className="flex flex-col gap-4">
          <ShieldCheck className="size-8 text-primary" aria-hidden />
          <h1 className="text-title font-semibold">Connect {info.data.client.name}?</h1>
          <p className="text-sm text-muted">
            {info.data.client.name} ({info.data.client.redirectHost}) wants to work with {info.data.appName}{' '}
            as you, with your permissions. You can disconnect it at any time in your profile.
          </p>
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1 text-xs font-medium text-muted">Allow it to</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="access"
                checked={chosen === 'read'}
                onChange={() => setAccess('read')}
              />
              Read records only
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="access"
                checked={chosen === 'full'}
                onChange={() => setAccess('full')}
              />
              Read and change records
            </label>
          </fieldset>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => decide.mutate(true)} loading={decide.isPending}>
              Allow
            </Button>
            <Button onClick={() => decide.mutate(false)} disabled={decide.isPending}>
              Decline
            </Button>
          </div>
          {decide.isError ? <ErrorState error={decide.error} /> : null}
        </div>
      </Pane>
    </div>
  );
}
