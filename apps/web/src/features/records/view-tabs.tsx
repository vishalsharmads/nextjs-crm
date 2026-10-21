import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MoreHorizontal, Plus, Users } from 'lucide-react';
import type { CoreEntity, FilterCondition, FilterNode } from '@app/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/cn';
import { useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import type { EntityConfig } from './entities';

interface SavedView {
  uuid: string;
  name: string;
  filters: FilterNode | null;
  columns: string[] | null;
  sort: { field: string; dir: 'asc' | 'desc' }[] | null;
  isShared: boolean;
  mine: boolean;
}

/** Saved views as tabs above the list. Unsaved filter changes offer "Save view". */
export function ViewTabs({
  entity,
  config,
  activeView,
  onSelect,
  conditions,
  sort,
  columns,
  onApplyColumns,
}: {
  entity: CoreEntity;
  config: EntityConfig;
  activeView: string | null;
  onSelect: (uuid: string | null) => void;
  conditions: FilterCondition[];
  sort?: string;
  columns: string[];
  onApplyColumns: (ids: string[]) => void;
}) {
  const qc = useQueryClient();
  const can = useCan();
  const views = useQuery({
    queryKey: qk.views(entity),
    queryFn: () => apiGet<{ data: SavedView[] }>('/saved-views', { entity }).then((r) => r.data),
  });
  const [dialog, setDialog] = useState<{ mode: 'create' | 'rename'; view?: SavedView } | null>(null);
  const active = views.data?.find((v) => v.uuid === activeView) ?? null;
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.views(entity) });
  const sortSpec = useMemo(
    () =>
      sort
        ? sort
            .split(',')
            .map((s) => ({
              field: s.replace(/^-/, ''),
              dir: s.startsWith('-') ? ('desc' as const) : ('asc' as const),
            }))
        : null,
    [sort],
  );
  const dirty = conditions.length > 0 || !!sort;

  const update = useMutation({
    mutationFn: (v: SavedView) =>
      apiPatch(`/saved-views/${v.uuid}`, {
        filters: conditions.length ? { and: conditions } : v.filters,
        columns,
        sort: sortSpec ?? v.sort,
      }),
    onSuccess: () => {
      toast.success('View updated');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (v: SavedView) => apiDelete(`/saved-views/${v.uuid}`),
    onSuccess: () => {
      onSelect(null);
      refresh();
    },
  });

  const select = (v: SavedView | null) => {
    onSelect(v?.uuid ?? null);
    if (v?.columns?.length) onApplyColumns(v.columns);
  };

  return (
    <div className="-mb-px flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="Views">
      <Tab active={!activeView} onClick={() => select(null)}>
        All {config.plural.toLowerCase()}
      </Tab>
      {views.data?.map((v) => (
        <Tab key={v.uuid} active={activeView === v.uuid} onClick={() => select(v)}>
          {v.name}
          {v.isShared ? <Users className="size-3 text-faint" aria-label="Shared" /> : null}
        </Tab>
      ))}
      {active && (active.mine || can('core.saved_views.share')) ? (
        <Menu>
          <MenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="View options">
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent align="start">
            {dirty ? (
              <MenuItem onSelect={() => update.mutate(active)}>Save changes to this view</MenuItem>
            ) : null}
            <MenuItem onSelect={() => setDialog({ mode: 'rename', view: active })}>Rename or share</MenuItem>
            <MenuItem danger onSelect={() => remove.mutate(active)}>
              Delete view
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : null}
      {dirty || !views.data?.length ? (
        <Button
          size="sm"
          variant="ghost"
          className="ms-1 text-primary"
          onClick={() => setDialog({ mode: 'create' })}
        >
          <Plus /> Save view
        </Button>
      ) : null}
      {dialog ? (
        <ViewDialog
          entity={entity}
          mode={dialog.mode}
          view={dialog.view}
          payload={{ filters: conditions.length ? { and: conditions } : null, columns, sort: sortSpec }}
          canShare={can('core.saved_views.share')}
          onClose={() => setDialog(null)}
          onSaved={(uuid) => {
            refresh();
            onSelect(uuid);
          }}
        />
      ) : null}
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap',
        active ? 'border-primary font-medium text-ink' : 'border-transparent text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function ViewDialog({
  entity,
  mode,
  view,
  payload,
  canShare,
  onClose,
  onSaved,
}: {
  entity: CoreEntity;
  mode: 'create' | 'rename';
  view?: SavedView;
  payload: {
    filters: FilterNode | null;
    columns: string[];
    sort: { field: string; dir: 'asc' | 'desc' }[] | null;
  };
  canShare: boolean;
  onClose: () => void;
  onSaved: (uuid: string) => void;
}) {
  const [name, setName] = useState(view?.name ?? '');
  const [shared, setShared] = useState(view?.isShared ?? false);
  const save = useMutation({
    mutationFn: () =>
      mode === 'create'
        ? apiPost<SavedView>('/saved-views', { entity, name, isShared: shared, ...payload })
        : apiPatch<SavedView>(`/saved-views/${view!.uuid}`, { name, isShared: shared }),
    onSuccess: (v) => {
      toast.success(mode === 'create' ? 'View saved' : 'View updated');
      onSaved(v.uuid);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={mode === 'create' ? 'Save view' : 'Edit view'}
        description={mode === 'create' ? 'Saves the current filters, sort and columns.' : undefined}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!name.trim()}
            >
              Save view
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            aria-label="View name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My hot prospects"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && save.mutate()}
          />
          {canShare ? (
            <label className="flex items-center justify-between text-sm">
              Share with everyone <Switch checked={shared} onCheckedChange={setShared} />
            </label>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
