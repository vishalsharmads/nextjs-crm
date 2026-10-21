import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { FilterBar } from '@/components/data/filter-bar';
import { useHotkeys } from '@/app/shell/hotkeys';
import { RecordFormSheet } from '@/features/records/record-form';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { KanbanSquare, List, Plus, Search } from 'lucide-react';
import type { FilterCondition } from '@app/shared';
import { useCan, usePipelines } from '@/app/session';
import { cn } from '@/lib/cn';
import { Combobox } from '@/components/fields/combobox';
import { RecordListPage } from '@/features/records/list-page';
import { RecordPeek } from '@/features/records/record-peek';
import { useEntityConfig, type EntityConfig } from '@/features/records/entities';
import { DealBoard } from './deal-board';

/** Deals as a list (shared list page) or a Kanban board per pipeline. */
export function DealsPage() {
  const [params, setParams] = useSearchParams();
  const mode = params.get('mode') === 'list' ? 'list' : 'board';
  const pipelines = usePipelines('deal');
  const pipeline =
    params.get('pipeline') ?? pipelines.find((p) => p.isDefault)?.uuid ?? pipelines[0]?.uuid ?? null;
  const config = useEntityConfig('deal');
  const navigate = useNavigate();
  const conditions = useMemo<FilterCondition[]>(() => {
    try {
      return params.get('filter')
        ? ((JSON.parse(params.get('filter')!) as { and: FilterCondition[] }).and ?? [])
        : [];
    } catch {
      return [];
    }
  }, [params]);
  const set = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );

  const toggle = (
    <div className="flex rounded-sm border border-line p-0.5" role="group" aria-label="View">
      {(
        [
          ['board', KanbanSquare, 'Board'],
          ['list', List, 'List'],
        ] as const
      ).map(([m, Icon, label]) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => set('mode', m === 'board' ? null : m)}
          className={cn(
            'flex h-6 items-center gap-1 rounded-[3px] px-2 text-xs',
            mode === m ? 'bg-primary-soft font-medium' : 'text-muted hover:text-ink',
          )}
        >
          <Icon className="size-3.5" /> {label}
        </button>
      ))}
    </div>
  );
  const pipelinePicker =
    pipelines.length > 1 ? (
      <div className="w-48">
        <Combobox
          clearable={false}
          value={pipeline}
          onChange={(v) => set('pipeline', v as string)}
          options={pipelines.map((p) => ({ value: p.uuid, label: p.name }))}
        />
      </div>
    ) : null;

  if (mode === 'list') return <RecordListPage entity="deal" headerExtra={toggle} />;

  return (
    <BoardShell config={config} toggle={toggle} pipelinePicker={pipelinePicker}>
      <DealBoard
        pipelineUuid={pipeline}
        q={params.get('q') ?? ''}
        conditions={conditions}
        onOpen={(uuid) => set('peek', uuid)}
      />
      {params.get('peek') ? (
        <RecordPeek
          config={config}
          uuid={params.get('peek')!}
          onClose={() => set('peek', null)}
          onOpenFull={() => navigate(`/deals/${params.get('peek')}`)}
        />
      ) : null}
    </BoardShell>
  );
}

function BoardShell({
  config,
  toggle,
  pipelinePicker,
  children,
}: {
  config: EntityConfig;
  toggle: ReactNode;
  pipelinePicker: ReactNode;
  children: ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const conditions = useMemo<FilterCondition[]>(() => {
    try {
      return params.get('filter')
        ? ((JSON.parse(params.get('filter')!) as { and: FilterCondition[] }).and ?? [])
        : [];
    } catch {
      return [];
    }
  }, [params]);
  useHotkeys({ c: () => can('core.deals.create') && setCreating(true) });
  const update = (k: string, v: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v) n.set(k, v);
      else n.delete(k);
      return n;
    });
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={config.plural}
        actions={
          <>
            {toggle}
            {can('core.deals.create') ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New {config.singular}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 md:px-6">
        {pipelinePicker}
        <div className="relative w-full max-w-56">
          <Search className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-3.5 text-faint" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && update('q', search || null)}
            onBlur={() => update('q', search || null)}
            placeholder={`Search ${config.plural.toLowerCase()}`}
            className="h-7 ps-8 text-xs"
            aria-label="Search"
          />
        </div>
        <FilterBar
          fields={config.fields.filter((f) => f.key !== 'stage' && f.key !== 'pipeline')}
          conditions={conditions}
          onChange={(c) => update('filter', c.length ? JSON.stringify({ and: c }) : null)}
        />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <RecordFormSheet config={config} open={creating} onOpenChange={setCreating} />
    </div>
  );
}
