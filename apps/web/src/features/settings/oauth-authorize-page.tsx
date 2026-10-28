import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { ApiError, apiGet, apiPost } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { ErrorState, Pane, Skeleton } from '@/components/ui/misc';

interface Info {
  appName: string;
  client: { name: string; redirectUri: string; registeredAt: string | null };
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
        access: access ?? 'read',
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
  // Read only unless the person deliberately chooses more.
  const chosen = access ?? 'read';
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <Pane>
        <div className="flex flex-col gap-4">
          <ShieldCheck className="size-8 text-primary" aria-hidden />
          <h1 className="text-title font-semibold">Connect an AI app?</h1>
          <p className="text-sm text-muted">
            An app calling itself “{info.data.client.name}” wants to work with {info.data.appName} as you,
            with your permissions. Its name is not verified: only continue if you started this connection
            yourself.
          </p>
          <dl className="grid gap-1 rounded-md border border-line bg-subtle p-3 text-xs">
            <dt className="text-muted">Access goes to</dt>
            <dd className="font-mono break-all">{info.data.client.redirectUri}</dd>
            {info.data.client.registeredAt ? (
              <>
                <dt className="mt-1 text-muted">App registered</dt>
                <dd>{formatDateTime(info.data.client.registeredAt)}</dd>
              </>
            ) : null}
          </dl>
          <p className="text-xs text-muted">You can disconnect it at any time in your profile.</p>
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
              Read and change records{info.data.wantsFull ? ' (the app asked for this)' : ''}
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
