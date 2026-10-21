import { useMemo, useState } from 'react';
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
import type { DealDto, FilterCondition } from '@app/shared';
import { apiGet, apiPatch } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney } from '@/lib/format';
import { useBoot, useCan } from '@/app/session';
import { Avatar, ErrorState, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ListSelect } from '@/components/fields/pickers';

interface Column {
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
  deals: DealDto[];
}
interface Board {
  pipeline: { uuid: string; name: string };
  columns: Column[];
}

export function DealBoard({
  pipelineUuid,
  q,
  conditions,
  onOpen,
}: {
  pipelineUuid: string | null;
  q: string;
  conditions: FilterCondition[];
  onOpen: (uuid: string) => void;
}) {
  const qc = useQueryClient();
  const can = useCan();
  const boot = useBoot();
  const params = {
    pipeline: pipelineUuid,
    q,
    filter: conditions.length ? JSON.stringify({ and: conditions }) : undefined,
  };
  const key = qk.board(params);
  const board = useQuery({
    queryKey: key,
    queryFn: () =>
      apiGet<Board>('/deals/board', {
        pipeline: pipelineUuid ?? undefined,
        q: q || undefined,
        filter: params.filter,
      }),
  });
  const [activeId, setActiveId] = useState<string | null>(null);
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
  const canMove = can('core.deals.update');

  const move = useMutation({
    mutationFn: (v: {
      uuid: string;
      stageUuid: string;
      beforeUuid?: string;
      afterUuid?: string;
      lostReason?: string;
    }) => apiPatch<DealDto>(`/deals/${v.uuid}/stage`, v),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Board>(key);
      if (prev) {
        const deal = prev.columns.flatMap((c) => c.deals).find((d) => d.uuid === v.uuid);
        if (deal) {
          const target = prev.columns.find((c) => c.stage.uuid === v.stageUuid)!;
          const columns = prev.columns.map((c) => {
            let deals = c.deals.filter((d) => d.uuid !== v.uuid);
            if (c.stage.uuid === v.stageUuid) {
              const moved = {
                ...deal,
                stage: {
                  ...deal.stage,
                  uuid: target.stage.uuid,
                  name: target.stage.name,
                  isWon: target.stage.isWon,
                  isLost: target.stage.isLost,
                },
              };
              const at = v.afterUuid
                ? deals.findIndex((d) => d.uuid === v.afterUuid)
                : v.beforeUuid
                  ? deals.findIndex((d) => d.uuid === v.beforeUuid) + 1
                  : deals.length;
              deals = [...deals.slice(0, Math.max(at, 0)), moved, ...deals.slice(Math.max(at, 0))];
            }
            const moving =
              c.stage.uuid !== deal.stage.uuid && c.stage.uuid === v.stageUuid
                ? 1
                : c.stage.uuid === deal.stage.uuid && c.stage.uuid !== v.stageUuid
                  ? -1
                  : 0;
            return { ...c, deals, count: c.count + moving, total: c.total + moving * deal.value };
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
      void qc.invalidateQueries({ queryKey: ['records', 'deals'] });
    },
  });

  const allDeals = useMemo(() => board.data?.columns.flatMap((c) => c.deals) ?? [], [board.data]);
  const active = allDeals.find((d) => d.uuid === activeId) ?? null;

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (!e.over || !board.data) return;
    const deal = allDeals.find((d) => d.uuid === e.active.id);
    if (!deal) return;
    const overId = String(e.over.id);
    const column =
      board.data.columns.find((c) => c.stage.uuid === overId) ??
      board.data.columns.find((c) => c.deals.some((d) => d.uuid === overId));
    if (!column) return;
    const siblings = column.deals.filter((d) => d.uuid !== deal.uuid);
    const overIndex = siblings.findIndex((d) => d.uuid === overId);
    const afterUuid = overIndex >= 0 ? siblings[overIndex]?.uuid : undefined;
    const beforeUuid =
      overIndex > 0 ? siblings[overIndex - 1]?.uuid : overIndex === -1 ? siblings.at(-1)?.uuid : undefined;
    if (column.stage.uuid === deal.stage.uuid && overId === deal.uuid) return;
    if (
      column.stage.isLost &&
      column.stage.uuid !== deal.stage.uuid &&
      boot.settings.deals.lostReasons.length
    ) {
      setLostPrompt({ deal, stageUuid: column.stage.uuid, before: beforeUuid, after: afterUuid });
      return;
    }
    move.mutate({ uuid: deal.uuid, stageUuid: column.stage.uuid, beforeUuid, afterUuid });
    if (column.stage.uuid !== deal.stage.uuid) toast.success(`Moved to ${column.stage.name}`);
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
        role="list"
        aria-label="Pipeline stages"
      >
        {board.data.columns.map((c) => (
          <BoardColumn key={c.stage.uuid} column={c} onOpen={onOpen} disabled={!canMove} />
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
        {active ? <DealCard deal={active} overlay /> : null}
      </DragOverlay>
      {lostPrompt ? (
        <LostReasonDialog
          deal={lostPrompt.deal}
          onCancel={() => setLostPrompt(null)}
          onConfirm={(reason) => {
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

function BoardColumn({
  column,
  onOpen,
  disabled,
}: {
  column: Column;
  onOpen: (uuid: string) => void;
  disabled: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage.uuid });
  const currency = column.deals[0]?.currency;
  return (
    <section
      role="listitem"
      aria-label={column.stage.name}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-md border border-line bg-subtle transition-colors',
        isOver && 'border-primary bg-primary-soft',
      )}
    >
      <header className="flex items-baseline justify-between gap-2 px-3 pt-3 pb-2">
        <h2 className="truncate text-sm font-semibold">
          {column.stage.name} <span className="font-normal text-muted tabular">{column.count}</span>
        </h2>
        <span className="text-xs text-muted tabular">{formatMoney(column.total, currency)}</span>
      </header>
      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={column.deals.map((d) => d.uuid)} strategy={verticalListSortingStrategy}>
          {column.deals.map((d) => (
            <SortableCard key={d.uuid} deal={d} onOpen={onOpen} disabled={disabled} />
          ))}
        </SortableContext>
        {!column.deals.length ? <p className="px-2 py-6 text-center text-xs text-faint">Drop here</p> : null}
      </div>
    </section>
  );
}

function SortableCard({
  deal,
  onOpen,
  disabled,
}: {
  deal: DealDto;
  onOpen: (uuid: string) => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: deal.uuid,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <DealCard deal={deal} onOpen={() => onOpen(deal.uuid)} />
    </div>
  );
}

function DealCard({ deal, onOpen, overlay }: { deal: DealDto; onOpen?: () => void; overlay?: boolean }) {
  return (
    <article
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}
      className={cn(
        'cursor-grab rounded-md border border-line bg-surface p-2.5 text-sm hover:border-line-strong',
        overlay && 'cursor-grabbing shadow-xl',
        deal.rotting && 'border-s-2 border-s-accent',
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

function LostReasonDialog({
  deal,
  onCancel,
  onConfirm,
}: {
  deal: DealDto;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const boot = useBoot();
  const [reason, setReason] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        title={`Why was “${deal.title}” lost?`}
        description="Knowing why helps you see patterns later."
        footer={
          <>
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={!reason} onClick={() => reason && onConfirm(reason)}>
              Mark as lost
            </Button>
          </>
        }
      >
        <ListSelect
          value={reason}
          onChange={setReason}
          options={boot.settings.deals.lostReasons}
          placeholder="Choose a reason"
        />
      </DialogContent>
    </Dialog>
  );
}
