import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { useBranding } from '@/app/branding';
import { useBoot, useCan } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/misc';
import { formatRelative } from '@/lib/format';
import { SettingsPage } from '@/features/settings/layout';
import { useEntityConfig } from './entities';
import { useRecordList, useRecordMutations } from './api';

type Trashed = { uuid: string; deletedAt: string | null } & Record<string, unknown>;

type TrashEntity = 'contact' | 'organization' | 'lead' | 'deal';
export const TRASH_ENTITIES: TrashEntity[] = ['contact', 'organization', 'lead', 'deal'];

/** Entities whose deleted records this user may see: needs the delete permission, and the feature on. */
export function useTrashEntities(): TrashEntity[] {
  const boot = useBoot();
  const can = useCan();
  const config = {
    contact: useEntityConfig('contact'),
    organization: useEntityConfig('organization'),
    lead: useEntityConfig('lead'),
    deal: useEntityConfig('deal'),
  };
  return TRASH_ENTITIES.filter(
    (e) => (e !== 'lead' || boot.settings.features.leads) && can(`${config[e].resource}.delete`),
  );
}

function TrashList({ entity }: { entity: TrashEntity }) {
  const config = useEntityConfig<Trashed>(entity);
  const list = useRecordList<Trashed>(config.route, {
    page: 1,
    pageSize: 50,
    trashed: 'only',
    sort: '-updated_at',
  });
  const { restore } = useRecordMutations<Trashed>(config.route);

  if (list.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (!list.data.data.length) {
    return (
      <EmptyState
        icon={<Trash2 />}
        title={`No deleted ${config.plural.toLowerCase()}`}
        description={`Deleted ${config.plural.toLowerCase()} show up here and can be restored.`}
      />
    );
  }
  return (
    <ul className="divide-y divide-line">
      {list.data.data.map((r) => (
        <li key={r.uuid} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{config.title(r) || 'Unnamed'}</p>
            <p className="truncate text-xs text-muted">
              {[config.subtitle?.(r), r.deletedAt ? `Deleted ${formatRelative(r.deletedAt)}` : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <Button
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate(r.uuid, {
                onSuccess: () => toast.success(`${config.singular} restored`),
                onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not restore'),
              })
            }
          >
            <ArchiveRestore /> Restore
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function TrashPage() {
  const entities = useTrashEntities();
  const boot = useBoot();
  const labels = useMemo(() => boot.labels, [boot.labels]);
  const { branding } = useBranding();
  useEffect(() => setDocumentTitle('Trash', branding.appName), [branding.appName]);
  const [tab, setTab] = useState<TrashEntity | null>(null);
  const active = tab && entities.includes(tab) ? tab : entities[0];

  return (
    <SettingsPage title="Trash" description="Restore records that were deleted by mistake.">
      {!active ? (
        <EmptyState
          icon={<Trash2 />}
          title="Nothing to show"
          description="You need permission to delete records to see the trash."
        />
      ) : (
        <Tabs value={active} onValueChange={(v) => setTab(v as TrashEntity)}>
          <TabsList>
            {entities.map((e) => (
              <TabsTrigger key={e} value={e}>
                {labels[e]?.plural ?? e}
              </TabsTrigger>
            ))}
          </TabsList>
          {entities.map((e) => (
            <TabsContent key={e} value={e} className="rounded-md border border-line bg-surface">
              <TrashList entity={e} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </SettingsPage>
  );
}
