import { Maximize2 } from 'lucide-react';
import type { RelatedType } from '@app/shared';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { Tooltip } from '@/components/ui/menu';
import { useHotkeys } from '@/app/shell/hotkeys';
import { ActivityComposer, ActivityItem, useNextActivity } from '@/features/activities/activity-components';
import { useRecord } from './api';
import type { EntityConfig } from './entities';
import { FieldsPanel } from './fields-panel';

type Rec = Record<string, unknown> & { uuid: string; custom: Record<string, unknown> };

/** Quick look at a record without leaving the list. Enter (or the button) opens the full page. */
export function RecordPeek({
  config,
  uuid,
  onClose,
  onOpenFull,
}: {
  config: EntityConfig;
  uuid: string;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const q = useRecord<Rec>(config.route, uuid);
  useHotkeys({ Enter: onOpenFull, o: onOpenFull });
  const related = config.entity !== 'activity' ? (config.entity as RelatedType) : null;
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={q.data ? config.title(q.data as never) : config.singular}
      description={q.data ? (config.subtitle?.(q.data as never) ?? undefined) : undefined}
      width="max-w-lg"
      headerActions={
        <Tooltip content="Open full page (Enter)">
          <Button size="icon-sm" variant="ghost" onClick={onOpenFull} aria-label="Open full page">
            <Maximize2 />
          </Button>
        </Tooltip>
      }
    >
      {q.isPending ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-40" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="flex flex-col gap-6 p-5">
          {related ? <NextUp type={related} uuid={uuid} /> : null}
          <FieldsPanel config={config} record={q.data} />
          {related ? <ActivityComposer related={{ type: related, uuid }} /> : null}
        </div>
      )}
    </Sheet>
  );
}

function NextUp({ type, uuid }: { type: RelatedType; uuid: string }) {
  const next = useNextActivity(type, uuid);
  if (!next) return null;
  return (
    <section className="rounded-md border border-line bg-subtle px-3">
      <h3 className="pt-2 text-xs font-semibold text-muted">Next up</h3>
      <ul>
        <ActivityItem a={next} />
      </ul>
    </section>
  );
}
