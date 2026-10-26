import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DealDto, StageDto } from '@app/shared';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/cn';
import { useBoot, useCan, useT } from '@/app/session';
import { Badge } from '@/components/ui/misc';
import { LostReasonDialog } from './lost-reason-dialog';
import { patchDealStage } from './stage-move';

/**
 * Where a deal is in its pipeline, with one click to move it. Stages before the current one read as done;
 * the current stage is solid, and a won or lost stage takes its own tone. Moves apply at once and can be undone.
 */
export function StageTrack({ deal }: { deal: DealDto }) {
  const qc = useQueryClient();
  const can = useCan();
  const t = useT();
  const { pipelines, settings } = useBoot();
  const [lostFor, setLostFor] = useState<StageDto | null>(null);
  const canMove = can('core.deals.update');
  const key = qk.record('deals', deal.uuid);

  const stages = useMemo(
    () =>
      [...(pipelines.find((p) => p.uuid === deal.pipeline.uuid)?.stages ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      ),
    [pipelines, deal.pipeline.uuid],
  );

  const move = useMutation({
    mutationFn: (v: { stage: StageDto; lostReason?: string }) =>
      patchDealStage({ uuid: deal.uuid, stageUuid: v.stage.uuid, lostReason: v.lostReason }),
    onMutate: async ({ stage }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<DealDto>(key);
      if (prev) {
        qc.setQueryData<DealDto>(key, {
          ...prev,
          stage: {
            ...prev.stage,
            uuid: stage.uuid,
            key: stage.key,
            name: stage.name,
            color: stage.color,
            probability: stage.probability,
            isWon: stage.isWon,
            isLost: stage.isLost,
          },
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(err instanceof Error ? err.message : 'Could not move');
    },
    onSuccess: (rec) => qc.setQueryData(key, rec),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.records('deals') });
    },
  });

  if (!stages.length) {
    return (
      <Badge tone={deal.stage.isWon ? 'primary' : deal.stage.isLost ? 'accent' : 'neutral'}>
        {deal.stage.name}
      </Badge>
    );
  }

  const needsReason = (s: StageDto) => s.isLost && settings.deals.lostReasons.length > 0;
  const currentIndex = stages.findIndex((s) => s.uuid === deal.stage.uuid);

  const choose = (stage: StageDto) => {
    if (stage.uuid === deal.stage.uuid) return;
    if (needsReason(stage)) return setLostFor(stage);
    const from = stages[currentIndex];
    const toastId = toast.success(`Moved to ${stage.name}`, {
      // Going back into a lost stage would need a reason again, so only offer undo when it does not.
      action:
        from && !needsReason(from)
          ? { label: 'Undo', onClick: () => move.mutate({ stage: from }) }
          : undefined,
    });
    // The move is shown at once; if the server refuses it, the toast (and its Undo) must not stay up.
    move.mutate({ stage }, { onError: () => toast.dismiss(toastId) });
  };

  return (
    <>
      <ol aria-label={t('common.pipelineStages')} className="-mx-1 flex gap-1 overflow-x-auto px-1 py-1">
        {stages.map((s, i) => {
          const current = s.uuid === deal.stage.uuid;
          const done = !deal.stage.isLost && currentIndex >= 0 && i < currentIndex;
          return (
            <li key={s.uuid} className="shrink-0">
              <button
                type="button"
                disabled={!canMove}
                aria-current={current ? 'step' : undefined}
                onClick={() => choose(s)}
                className={cn(
                  'h-8 rounded-sm px-3 text-xs font-medium whitespace-nowrap transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.97] disabled:cursor-default pointer-coarse:h-10',
                  current && !s.isLost && 'bg-primary text-primary-fg',
                  current && s.isLost && 'bg-accent text-accent-fg',
                  !current && done && 'bg-primary-soft text-ink',
                  !current && !done && 'bg-subtle text-muted',
                  !current && canMove && 'hover:bg-hover hover:text-ink',
                )}
              >
                {s.name}
              </button>
            </li>
          );
        })}
      </ol>
      {lostFor ? (
        <LostReasonDialog
          deal={deal}
          onCancel={() => setLostFor(null)}
          onConfirm={(reason) => {
            move.mutate({ stage: lostFor, lostReason: reason });
            toast.success(`Moved to ${lostFor.name}`);
            setLostFor(null);
          }}
        />
      ) : null}
    </>
  );
}
