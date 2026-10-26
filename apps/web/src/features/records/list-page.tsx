import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Columns3, Download, Plus, Rows3, Rows4, Search, Inbox, Upload } from 'lucide-react';
import { buildUrl } from '@/lib/api';
import type { CoreEntity, FilterCondition } from '@app/shared';
import { useBranding } from '@/app/branding';
import { useBoot, useCan } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState, ErrorState, PageHeader } from '@/components/ui/misc';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/menu';
import { DataTable, type Column } from '@/components/data/data-table';
import { FilterBar } from '@/components/data/filter-bar';
import { useHotkeys } from '@/app/shell/hotkeys';
import { usePaletteCommands } from '@/app/shell/command-palette';
import { useRecordList } from './api';
import { useEntityConfig, type EntityConfig } from './entities';
import { RecordFormSheet } from './record-form';
import { RecordPeek } from './record-peek';
import { BulkBar } from './bulk-bar';
import { ViewTabs } from './view-tabs';

const PAGE_SIZE = 50;

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

/** URL is the source of truth for list state, so links are shareable and back/forward works. */
function useListState() {
  const [params, setParams] = useSearchParams();
  const conditions = useMemo<FilterCondition[]>(() => {
    try {
      const f = params.get('filter');
      return f ? ((JSON.parse(f) as { and: FilterCondition[] }).and ?? []) : [];
    } catch {
      return [];
    }
  }, [params]);
  const set = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return {
    q: params.get('q') ?? '',
    sort: params.get('sort') ?? undefined,
    page: Number(params.get('page') ?? 1),
    view: params.get('view'),
    peek: params.get('peek'),
    create: params.get('new') === '1',
    conditions,
    set,
    setConditions: (c: FilterCondition[]) => set({ filter: c.length ? JSON.stringify({ and: c }) : null }),
  };
}

export function RecordListPage({
  entity,
  headerExtra,
  toolbarExtra,
}: {
  entity: CoreEntity;
  headerExtra?: ReactNode;
  toolbarExtra?: ReactNode;
}) {
  const config = useEntityConfig(entity);
  const boot = useBoot();
  const can = useCan();
  const navigate = useNavigate();
  const { branding } = useBranding();
  const state = useListState();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() =>
    readJson('ui.density', 'comfortable'),
  );
  const [search, setSearch] = useState(state.q);

  useEffect(() => {
    if (state.create) {
      setCreating(true);
      state.set({ new: null });
    }
  }, [state]);
  useEffect(() => setDocumentTitle(config.plural, branding.appName), [config.plural, branding.appName]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== state.q) state.set({ q: search || null });
    }, 300);
    return () => clearTimeout(t);
  }, [search, state]);
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [state.q, state.view, state.conditions]);

  const layoutColumns = boot.layouts.find((l) => l.entity === entity && l.context === 'list')?.columns;
  const [columnIds, setColumnIds] = useState<string[]>(() =>
    readJson(`ui.columns.${entity}`, layoutColumns ?? config.defaultColumns),
  );
  const saveColumns = (ids: string[]) => {
    setColumnIds(ids);
    writeJson(`ui.columns.${entity}`, ids);
  };

  const list = useRecordList<Record<string, unknown>>(config.route, {
    page: state.page,
    pageSize: PAGE_SIZE,
    sort: state.sort,
    q: state.q,
    view: state.view,
    filter: state.conditions.length ? { and: state.conditions } : null,
  });

  const byKey = useMemo(() => new Map(config.fields.map((f) => [f.key, f])), [config.fields]);
  const columns: Column<Record<string, unknown>>[] = useMemo(
    () =>
      columnIds
        .map((id) => byKey.get(id))
        .filter((f) => !!f && !f.formOnly)
        .map((f) => ({
          id: f!.key,
          header: f!.label,
          width: f!.width ?? 160,
          sortable: f!.sortable,
          align: f!.kind === 'money' ? 'end' : 'start',
          cell: (r) => (f!.render ? f!.render(r) : String(f!.get(r) ?? '')),
        })),
    [columnIds, byKey],
  );

  const canCreate = can(`${config.resource}.create`);
  const openCreate = useCallback(() => canCreate && setCreating(true), [canCreate]);
  useHotkeys({ c: openCreate });
  usePaletteCommands(
    useMemo(
      () =>
        canCreate
          ? [
              {
                id: `create:${entity}`,
                label: `New ${config.singular}`,
                group: 'Create',
                icon: Plus,
                shortcut: 'c',
                run: () => setCreating(true),
              },
            ]
          : [],
      [canCreate, entity, config.singular],
    ),
  );

  const filtered = state.q || state.conditions.length || state.view;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={config.plural}
        actions={
          <>
            {headerExtra}
            {canCreate ? (
              <Tooltip content="Shortcut: c">
                <Button variant="primary" onClick={openCreate}>
                  <Plus /> New {config.singular}
                </Button>
              </Tooltip>
            ) : null}
          </>
        }
      >
        <ViewTabs
          entity={entity}
          config={config}
          activeView={state.view}
          onSelect={(uuid) => state.set({ view: uuid })}
          conditions={state.conditions}
          sort={state.sort}
          columns={columnIds}
          onApplyColumns={saveColumns}
        />
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 md:px-6">
        <div className="relative w-full max-w-64">
          <Search className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-3.5 text-faint" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${config.plural.toLowerCase()}`}
            className="h-7 ps-8 text-xs"
            aria-label="Search"
          />
        </div>
        <FilterBar fields={config.fields} conditions={state.conditions} onChange={state.setConditions} />
        <div className="ms-auto flex items-center gap-1">
          {toolbarExtra}
          {entity !== 'activity' && can(`${config.resource}.import`) ? (
            <Button size="sm" variant="ghost" onClick={() => navigate(`/import/${config.route}`)}>
              <Upload /> Import
            </Button>
          ) : null}
          {entity !== 'activity' && can(`${config.resource}.export`) ? (
            <Button size="sm" variant="ghost" asChild>
              <a
                href={buildUrl(`/${config.route}/export`, {
                  filter: state.conditions.length ? JSON.stringify({ and: state.conditions }) : undefined,
                  q: state.q || undefined,
                  view: state.view ?? undefined,
                  sort: state.sort,
                })}
                download
              >
                <Download /> Export
              </a>
            </Button>
          ) : null}
          <ColumnPicker config={config} value={columnIds} onChange={saveColumns} />
          <Tooltip content={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Toggle density"
              onClick={() => {
                const next = density === 'compact' ? 'comfortable' : 'compact';
                setDensity(next);
                writeJson('ui.density', next);
              }}
            >
              {density === 'compact' ? <Rows3 /> : <Rows4 />}
            </Button>
          </Tooltip>
        </div>
      </div>
      {selected.size ? (
        <BulkBar
          config={config}
          selected={selected}
          total={list.data?.meta.total}
          allMatching={allMatching}
          onSelectAllMatching={() => setAllMatching(true)}
          criteria={{ conditions: state.conditions, q: state.q, view: state.view }}
          onClear={() => {
            setSelected(new Set());
            setAllMatching(false);
          }}
        />
      ) : null}
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          rows={list.data?.data}
          columns={columns}
          rowKey={(r) => r.uuid as string}
          loading={list.isPending}
          sort={state.sort ?? config.defaultSort}
          onSortChange={(s) => state.set({ sort: s ?? null })}
          selected={selected}
          onSelectedChange={setSelected}
          onRowOpen={(r) => state.set({ peek: r.uuid as string, page: String(state.page) })}
          activeKey={state.peek}
          page={state.page}
          pageSize={PAGE_SIZE}
          total={list.data?.meta.total ?? 0}
          onPageChange={(p) => state.set({ page: String(p) })}
          density={density}
          empty={
            filtered ? (
              <EmptyState
                icon={<Search />}
                title="Nothing matches"
                description="Try a different search or remove a filter."
                action={
                  <Button onClick={() => (setSearch(''), state.set({ q: null, filter: null, view: null }))}>
                    Clear search and filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Inbox />}
                title={`No ${config.plural.toLowerCase()} yet`}
                description={`Add your first ${config.singular.toLowerCase()} or import a spreadsheet.`}
                action={
                  canCreate ? (
                    <Button variant="primary" onClick={openCreate}>
                      <Plus /> New {config.singular}
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        />
      )}
      <RecordFormSheet
        config={config}
        open={creating}
        onOpenChange={setCreating}
        onSaved={(r: { uuid: string }) => state.set({ peek: r.uuid })}
      />
      {state.peek ? (
        <RecordPeek
          config={config}
          uuid={state.peek}
          onClose={() => state.set({ peek: null, page: String(state.page) })}
          onOpenFull={() => navigate(`/${config.route}/${state.peek}`)}
        />
      ) : null}
    </div>
  );
}

function ColumnPicker({
  config,
  value,
  onChange,
}: {
  config: EntityConfig;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const available = config.fields.filter((f) => !f.formOnly);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          <Columns3 /> Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <div className="max-h-80 overflow-y-auto">
          {available.map((f) => {
            const on = value.includes(f.key);
            return (
              <label
                key={f.key}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-hover"
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={(v) => onChange(v ? [...value, f.key] : value.filter((k) => k !== f.key))}
                  aria-label={f.label}
                />
                <span className="truncate">{f.label}</span>
              </label>
            );
          })}
        </div>
        <div className="border-t border-line p-1">
          <Button
            size="sm"
            variant="ghost"
            className="w-full"
            onClick={() => onChange(config.defaultColumns)}
          >
            Reset columns
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
