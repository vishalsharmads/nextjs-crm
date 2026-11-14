import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, GitMerge, X } from 'lucide-react';
import type { DuplicatePairDto } from '@app/shared';
import { apiGet, apiPost } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useCan, useLabel } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { confirmAction } from '@/components/ui/confirm';

const KEY = ['duplicate-pairs'] as const;
const ROUTE = { contact: 'contacts', organization: 'organizations' } as const;

/** Possible duplicates found by the nightly scan, for people who may merge them. */
export function DuplicatesPage() {
  const can = useCan();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => apiGet<{ data: DuplicatePairDto[] }>('/duplicates/pairs').then((r) => r.data),
  });
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="Possible duplicates"
        description="Records that a duplicate rule matched. Merge them into one, or mark them as different so they do not come back."
        actions={
          can('core.settings.manage') ? (
            <Button asChild>
              <Link to="/settings/duplicates">Duplicate rules</Link>
            </Button>
          ) : null
        }
      />
      <div className="mt-4">
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data.length ? (
          <EmptyState
            icon={<Copy />}
            title="No possible duplicates"
            description="The scan runs every night. New matches appear here when you may merge both records."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {q.data.map((p) => (
              <PairRow key={p.uuid} pair={p} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PairRow({ pair }: { pair: DuplicatePairDto }) {
  const qc = useQueryClient();
  const label = useLabel(pair.entity);
  const route = ROUTE[pair.entity];
  const done = () => void qc.invalidateQueries({ queryKey: KEY });
  const merge = useMutation({
    mutationFn: (keep: 'a' | 'b') =>
      apiPost(`/${route}/merge`, {
        primaryUuid: pair[keep].uuid,
        secondaryUuids: [pair[keep === 'a' ? 'b' : 'a'].uuid],
      }),
    onSuccess: () => {
      toast.success('Merged');
      done();
    },
  });
  const dismiss = useMutation({
    mutationFn: () => apiPost(`/duplicates/pairs/${pair.uuid}/dismiss`),
    onSuccess: () => {
      toast.success('Marked as different');
      done();
    },
  });
  const keep = (side: 'a' | 'b') =>
    void confirmAction({
      title: `Keep “${pair[side].title}” and merge the other into it?`,
      description:
        'Activities, deals, files and comments move to the kept record; empty fields are filled from the other. The other record goes away.',
      action: 'Merge',
    }).then((ok) => ok && merge.mutate(side));
  return (
    <li className="rounded-md border border-line bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge>{label.singular}</Badge>
        {pair.rule ? <span>{pair.rule}</span> : null}
        <span>· found {formatRelative(pair.createdAt)}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {(['a', 'b'] as const).map((side) => (
          <div key={side} className="flex items-center gap-2 rounded-sm bg-subtle px-3 py-2">
            <div className="min-w-0 flex-1">
              <Link
                to={`/${route}/${pair[side].uuid}`}
                className="block truncate font-medium hover:underline"
              >
                {pair[side].title || '(no name)'}
              </Link>
              {pair[side].subtitle ? (
                <p className="truncate text-xs text-muted">{pair[side].subtitle}</p>
              ) : null}
            </div>
            <Button
              size="sm"
              onClick={() => keep(side)}
              loading={merge.isPending && merge.variables === side}
            >
              <GitMerge /> Keep this
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} loading={dismiss.isPending}>
          <X /> Not a duplicate
        </Button>
      </div>
    </li>
  );
}
