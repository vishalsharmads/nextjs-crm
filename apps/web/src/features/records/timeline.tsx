import { useQuery } from '@tanstack/react-query';
import { ArrowRightLeft, FilePlus, GitMerge, PencilLine, Sparkles } from 'lucide-react';
import type { TimelineItem } from '@app/shared';
import { apiGet } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { formatRelative, formatDateTime } from '@/lib/format';
import { EmptyState, Skeleton } from '@/components/ui/misc';
import { ActivityItem } from '@/features/activities/activity-components';
import type { EntityConfig } from './entities';

const ICON = {
  created: Sparkles,
  change: PencilLine,
  stage: ArrowRightLeft,
  file: FilePlus,
  merged: GitMerge,
} as const;

function fieldLabel(config: EntityConfig, key: string) {
  const k = key.startsWith('custom.') ? `cf.${key.slice(7)}` : key;
  const byInput = config.fields.find(
    (f) => f.input && f.input.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) === key,
  );
  return (
    config.fields.find((f) => f.key === k)?.label ??
    byInput?.label ??
    key.replace(/_id$/, '').replace(/_/g, ' ')
  );
}

function fmt(v: unknown) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function Timeline({ config, uuid }: { config: EntityConfig; uuid: string }) {
  const q = useQuery({
    queryKey: qk.timeline(config.route, uuid),
    queryFn: () =>
      apiGet<{ data: TimelineItem[] }>(`/${config.route}/${uuid}/timeline`, { limit: 100 }).then(
        (r) => r.data,
      ),
  });
  if (q.isPending) return <Skeleton className="h-40" />;
  if (!q.data?.length)
    return (
      <EmptyState
        title="Nothing here yet"
        description="Notes, calls, changes and stage moves will appear here."
      />
    );
  return (
    <ol className="relative flex flex-col">
      {q.data.map((item) => {
        if (item.kind === 'activity' && item.activity) {
          return (
            <li key={item.id} className="border-b border-line last:border-0">
              <ul>
                {/* Rolled up from a related record (a contact's deal): say where it was logged. */}
                <ActivityItem a={item.activity} showRelated={item.activity.related?.uuid !== uuid} />
              </ul>
            </li>
          );
        }
        const Icon = ICON[item.kind as keyof typeof ICON] ?? PencilLine;
        const detail =
          item.kind === 'change' && item.detail
            ? Object.entries(item.detail as Record<string, { from: unknown; to: unknown }>)
            : [];
        return (
          <li key={item.id} className="flex gap-3 border-b border-line py-2.5 last:border-0">
            <Icon className="mt-0.5 size-4 shrink-0 text-faint" />
            <div className="min-w-0 flex-1 text-sm">
              <p>
                <span className="font-medium">{item.actor?.name ?? 'System'}</span>{' '}
                <span className="text-muted">{item.title}</span>
                {detail.length === 1 ? (
                  <span className="text-muted"> {fieldLabel(config, detail[0]![0])}</span>
                ) : null}
              </p>
              {detail.length ? (
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted">
                  {detail.map(([k, v]) => (
                    <li key={k} className="truncate">
                      {detail.length > 1 ? <span className="text-ink">{fieldLabel(config, k)}: </span> : null}
                      <span className="line-through decoration-faint">{fmt(v?.from)}</span> →{' '}
                      <span className="text-ink">{fmt(v?.to)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <time className="text-xs text-faint" dateTime={item.at} title={formatDateTime(item.at)}>
                {formatRelative(item.at)}
              </time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
