import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import type { DealDto, FilterCondition, LeadDto } from '@app/shared';
import { apiGet, apiPatch } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney } from '@/lib/format';
import { useBoot, useCan, useT } from '@/app/session';
import { Avatar, ErrorState, Skeleton } from '@/components/ui/misc';
import { StageDot, stageStyle } from '@/components/data/stage-color';
import { LostReasonDialog } from '@/features/deals/lost-reason-dialog';
import type { StageMove } from '@/features/deals/stage-move';
import { useNavigate } from 'react-router';

export type BoardEntity = 'deal' | 'lead';
type BoardRecord = DealDto | LeadDto;

export interface Column {
  stage: {
    uuid: string;
    key: string;
    name: string;
    color: string | null;
    probability: number;
    isWon: boolean;
    isLost: boolean;
    rottingDays: number | null;
  };
  count: number;
  total: number;
  records: BoardRecord[];
}
interface Board {
  pipeline: { uuid: string; name: string };
  columns: Column[];
}
type BoardResponse = {
  pipeline: Board['pipeline'];
  columns: (Omit<Column, 'records'> & { deals?: DealDto[]; leads?: LeadDto[] })[];
};

const ROUTE: Record<BoardEntity, 'deals' | 'leads'> = { deal: 'deals', lead: 'leads' };

const moveRecord = (entity: BoardEntity, v: StageMove) =>
  apiPatch<BoardRecord>(`/${ROUTE[entity]}/${v.uuid}/stage`, v);

/** A Kanban board of deals or leads on one pipeline: drag cards between stages and within a column. */
export function PipelineBoard({
  entity,
  pipelineUuid,
  q,
  conditions,
  onOpen,
}: {
  entity: BoardEntity;
  pipelineUuid: string | null;
  q: string;
  conditions: FilterCondition[];
  onOpen: (uuid: string) => void;
}) {
  const qc = useQueryClient();
  const can = useCan();
  const t = useT();
  const boot = useBoot();
  const navigate = useNavigate();
  const params = {
    pipeline: pipelineUuid,
    q,
    filter: conditions.length ? JSON.stringify({ and: conditions }) : undefined,
  };
  const route = ROUTE[entity];
  const key = qk.board(route, params);
  const board = useQuery({
    queryKey: key,
    queryFn: () =>
      apiGet<BoardResponse>(`/${route}/board`, {
        pipeline: pipelineUuid ?? undefined,
        q: q || undefined,
        filter: params.filter,
      }).then((b): Board => ({
        pipeline: b.pipeline,
        columns: b.columns.map(({ deals, leads, ...c }) => ({ ...c, records: deals ?? leads ?? [] })),
      })),
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  // The card that was just moved gets a short highlight that settles, so the eye can follow it to its new place.
  const [settledId, setSettledId] = useState<string | null>(null);
  useEffect(() => {
    if (!settledId) return;
    const t = setTimeout(() => setSettledId(null), 650);
    return () => clearTimeout(t);
  }, [settledId]);
  const [lostPrompt, setLostPrompt] = useState<{
    deal: DealDto;
    stageUuid: string;
    before?: string;
    after?: string;
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const canMove = can(`core.${route}.update`);

  const move = useMutation({
    mutationFn: (v: StageMove) => moveRecord(entity, v),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Board>(key);
      if (prev) {
        const deal = prev.columns.flatMap((c) => c.records).find((d) => d.uuid === v.uuid);
        if (deal?.stage) {
          const from = deal.stage.uuid;
          const amount = 'value' in deal ? deal.value : 0;
          const target = prev.columns.find((c) => c.stage.uuid === v.stageUuid)!;
          const columns = prev.columns.map((c) => {
            let deals = c.records.filter((d) => d.uuid !== v.uuid);
            if (c.stage.uuid === v.stageUuid) {
              const moved = {
                ...deal,
                stage: {
                  ...deal.stage,
                  uuid: target.stage.uuid,
                  name: target.stage.name,
                  color: target.stage.color,
                  isWon: target.stage.isWon,
                  isLost: target.stage.isLost,
                },
              } as BoardRecord;
              const at = v.afterUuid
                ? deals.findIndex((d) => d.uuid === v.afterUuid)
                : v.beforeUuid
                  ? deals.findIndex((d) => d.uuid === v.beforeUuid) + 1
                  : deals.length;
              deals = [...deals.slice(0, Math.max(at, 0)), moved, ...deals.slice(Math.max(at, 0))];
            }
            const moving =
              c.stage.uuid !== from && c.stage.uuid === v.stageUuid
                ? 1
                : c.stage.uuid === from && c.stage.uuid !== v.stageUuid
                  ? -1
                  : 0;
            return { ...c, records: deals, count: c.count + moving, total: c.total + moving * amount };
          });
          qc.setQueryData(key, { ...prev, columns });
        }
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(err instanceof Error ? err.message : 'Could not move');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['records', route] });
    },
  });

  const allDeals = useMemo(() => board.data?.columns.flatMap((c) => c.records) ?? [], [board.data]);
  const active = allDeals.find((d) => d.uuid === activeId) ?? null;

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (!e.over || !board.data) return;
    const deal = allDeals.find((d) => d.uuid === e.active.id);
    if (!deal?.stage) return;
    const fromStage = deal.stage.uuid;
    const overId = String(e.over.id);
    const column =
      board.data.columns.find((c) => c.stage.uuid === overId) ??
      board.data.columns.find((c) => c.records.some((d) => d.uuid === overId));
    if (!column) return;
    const siblings = column.records.filter((d) => d.uuid !== deal.uuid);
    const overIndex = siblings.findIndex((d) => d.uuid === overId);
    const afterUuid = overIndex >= 0 ? siblings[overIndex]?.uuid : undefined;
    const beforeUuid =
      overIndex > 0 ? siblings[overIndex - 1]?.uuid : overIndex === -1 ? siblings.at(-1)?.uuid : undefined;
    if (column.stage.uuid === fromStage && overId === deal.uuid) return;
    if (
      entity === 'deal' &&
      column.stage.isLost &&
      column.stage.uuid !== fromStage &&
      boot.settings.deals.lostReasons.length
    ) {
      setLostPrompt({
        deal: deal as DealDto,
        stageUuid: column.stage.uuid,
        before: beforeUuid,
        after: afterUuid,
      });
      return;
    }
    move.mutate({ uuid: deal.uuid, stageUuid: column.stage.uuid, beforeUuid, afterUuid });
    setSettledId(deal.uuid);
    if (column.stage.uuid === fromStage) return;
    // A lead reaching the won stage is ready to convert: offer it right from the toast.
    const convertable =
      entity === 'lead' &&
      column.stage.isWon &&
      !(deal as LeadDto).convertedAt &&
      can('core.contacts.create');
    toast.success(`Moved to ${column.stage.name}`, {
      action: convertable
        ? { label: 'Convert', onClick: () => navigate(`/leads/${deal.uuid}?convert=1`) }
        : undefined,
    });
  };

  if (board.isPending) {
    return (
      <div className="flex gap-3 overflow-x-auto p-4 md:px-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-96 w-72 shrink-0" />
        ))}
      </div>
    );
  }
  if (board.isError) return <ErrorState error={board.error} onRetry={() => board.refetch()} />;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div
        className="flex h-full min-h-0 gap-3 overflow-x-auto p-4 md:px-6"
        data-tour="board"
        role="list"
        aria-label={t('common.pipelineStages')}
      >
        {board.data.columns.map((c) => (
          <BoardColumn
            key={c.stage.uuid}
            column={c}
            onOpen={onOpen}
            disabled={!canMove}
            dragging={!!activeId}
            settledId={settledId}
          />
        ))}
      </div>
      {/* After a move the card appears in its new column with a highlight, so the overlay must not fly back to the
          old spot first (the optimistic update lands a tick after the drop). A cancelled drag still glides home. */}
      <DragOverlay
        dropAnimation={settledId ? null : { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }}
      >
        {active ? <RecordCard record={active} overlay /> : null}
      </DragOverlay>
      {lostPrompt ? (
        <LostReasonDialog
          deal={lostPrompt.deal}
          onCancel={() => setLostPrompt(null)}
          onConfirm={(reason) => {
            setSettledId(lostPrompt.deal.uuid);
            move.mutate({
              uuid: lostPrompt.deal.uuid,
              stageUuid: lostPrompt.stageUuid,
              beforeUuid: lostPrompt.before,
              afterUuid: lostPrompt.after,
              lostReason: reason,
            });
            setLostPrompt(null);
          }}
        />
      ) : null}
    </DndContext>
  );
}

export function BoardColumn({
  column,
  onOpen,
  disabled,
  dragging,
  settledId,
}: {
  column: Column;
  onOpen: (uuid: string) => void;
  disabled: boolean;
  /** A card is being dragged somewhere on the board. */
  dragging: boolean;
  settledId: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage.uuid });
  const first = column.records[0];
  const currency = first && 'currency' in first ? first.currency : undefined;
  const showTotal = !!first && 'value' in first;
  return (
    <section
      role="listitem"
      aria-label={column.stage.name}
      style={stageStyle(column.stage.color)}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-md border border-t-[3px] border-line border-t-(--sc) bg-subtle transition-colors',
        isOver && 'border-primary bg-primary-soft',
      )}
    >
      <header className="flex items-baseline justify-between gap-2 px-3 pt-3 pb-2">
        <h2 className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold">
          <StageDot color={column.stage.color} />
          {column.stage.name} <span className="font-normal text-muted tabular">{column.count}</span>
        </h2>
        {showTotal ? (
          <span className="text-xs text-muted tabular">{formatMoney(column.total, currency)}</span>
        ) : null}
      </header>
      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={column.records.map((d) => d.uuid)} strategy={verticalListSortingStrategy}>
          {column.records.map((d) => (
            <SortableCard
              key={d.uuid}
              record={d}
              onOpen={onOpen}
              disabled={disabled}
              settled={settledId === d.uuid}
              // Right after a drop the column is already in its final order; sliding the neighbours back
              // would only cross the card that just arrived.
              instant={settledId !== null}
            />
          ))}
        </SortableContext>
        {!column.records.length && dragging ? (
          <p className="px-2 py-6 text-center text-xs text-faint">Drop here</p>
        ) : null}
      </div>
    </section>
  );
}

function SortableCard({
  record,
  onOpen,
  disabled,
  settled,
  instant,
}: {
  record: BoardRecord;
  onOpen: (uuid: string) => void;
  disabled: boolean;
  settled: boolean;
  instant: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: record.uuid,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition: instant ? 'none' : transition }}
      className={cn(isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <RecordCard record={record} onOpen={() => onOpen(record.uuid)} settled={settled} />
    </div>
  );
}

function RecordCard({
  record,
  onOpen,
  overlay,
  settled,
}: {
  record: BoardRecord;
  onOpen?: () => void;
  overlay?: boolean;
  settled?: boolean;
}) {
  if (!('title' in record))
    return <LeadCard lead={record} onOpen={onOpen} overlay={overlay} settled={settled} />;
  const deal = record;
  return (
    <article
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}
      className={cn(
        'cursor-grab rounded-md border border-line bg-surface p-2.5 text-sm hover:border-line-strong',
        overlay && 'cursor-grabbing shadow-xl',
        deal.rotting && 'border-s-2 border-s-accent',
        settled && 'anim-settle',
      )}
    >
      <p className="line-clamp-2 font-medium">{deal.title}</p>
      {deal.organization || deal.contact ? (
        <p className="mt-0.5 truncate text-xs text-muted">{deal.organization?.name ?? deal.contact?.name}</p>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="tabular font-medium">{formatMoney(deal.value, deal.currency)}</span>
        <span className="flex items-center gap-1.5 text-muted">
          {deal.rotting ? (
            <AlertTriangle className="size-3 text-accent" aria-label="Stalled in this stage" />
          ) : null}
          {deal.expectedClose ? <span>{formatDate(deal.expectedClose)}</span> : null}
          {deal.owner ? <Avatar name={deal.owner.name} size="sm" /> : null}
        </span>
      </div>
    </article>
  );
}

function LeadCard({
  lead,
  onOpen,
  overlay,
  settled,
}: {
  lead: LeadDto;
  onOpen?: () => void;
  overlay?: boolean;
  settled?: boolean;
}) {
  return (
    <article
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}
      className={cn(
        'cursor-grab rounded-md border border-line bg-surface p-2.5 text-sm hover:border-line-strong',
        overlay && 'cursor-grabbing shadow-xl',
        lead.rotting && 'border-s-2 border-s-accent',
        settled && 'anim-settle',
      )}
    >
      <p className="line-clamp-2 font-medium">{lead.fullName}</p>
      {lead.companyName || lead.email ? (
        <p className="mt-0.5 truncate text-xs text-muted">{lead.companyName ?? lead.email}</p>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate">{lead.source ?? ''}</span>
        <span className="flex items-center gap-1.5">
          {lead.rotting ? (
            <AlertTriangle className="size-3 text-accent" aria-label="Stalled in this stage" />
          ) : null}
          {lead.convertedAt ? <span>Converted</span> : null}
          {lead.owner ? <Avatar name={lead.owner.name} size="sm" /> : null}
        </span>
      </div>
    </article>
  );
}
