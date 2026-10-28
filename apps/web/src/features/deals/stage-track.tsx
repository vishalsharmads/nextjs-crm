import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DealDto, LeadDto, StageDto } from '@app/shared';
import { apiPatch } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/cn';
import { useBoot, useCan, useT } from '@/app/session';
import { StageBadge, stageStyle } from '@/components/data/stage-color';
import { LostReasonDialog } from './lost-reason-dialog';
import { patchDealStage } from './stage-move';

interface Tracked {
  uuid: string;
  pipeline: { uuid: string } | null;
  stage: {
    uuid: string;
    key: string;
    name: string;
    color: string | null;
    isWon: boolean;
    isLost: boolean;
  } | null;
  stageEnteredAt: string | null;
}

/**
 * Where a deal or lead is in its pipeline, with one click to move it. Stages before the current one read as
 * done and the current stage takes its color. Moves apply at once and can be undone; a lead reaching the won
 * stage is offered `onConvert` instead.
 */
export function StageTrack(props: { deal: DealDto } | { lead: LeadDto; onConvert?: () => void }) {
  const isDeal = 'deal' in props;
  const rec: Tracked = isDeal ? props.deal : props.lead;
  const onConvert = isDeal ? undefined : props.onConvert;
  const route = isDeal ? 'deals' : 'leads';
  const qc = useQueryClient();
  const can = useCan();
  const t = useT();
  const { pipelines, settings } = useBoot();
  const [lostFor, setLostFor] = useState<StageDto | null>(null);
  const canMove = can(`core.${route}.update`);
  const key = qk.record(route, rec.uuid);
  const pipelineUuid = rec.pipeline?.uuid;

  const stages = useMemo(
    () =>
      [...(pipelines.find((p) => p.uuid === pipelineUuid)?.stages ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      ),
    [pipelines, pipelineUuid],
  );

  const move = useMutation({
    mutationFn: (v: { stage: StageDto; lostReason?: string }): Promise<DealDto | LeadDto> =>
      isDeal
        ? patchDealStage({ uuid: rec.uuid, stageUuid: v.stage.uuid, lostReason: v.lostReason })
        : apiPatch<LeadDto>(`/leads/${rec.uuid}/stage`, { stageUuid: v.stage.uuid }),
    onMutate: async ({ stage }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Tracked>(key);
      if (prev?.stage) {
        qc.setQueryData<Tracked>(key, {
          ...prev,
          stage: {
            ...prev.stage,
            uuid: stage.uuid,
            key: stage.key,
            name: stage.name,
            color: stage.color,
            ...(isDeal ? { probability: stage.probability } : {}),
            isWon: stage.isWon,
            isLost: stage.isLost,
          },
          stageEnteredAt: new Date().toISOString(),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error(err instanceof Error ? err.message : 'Could not move');
    },
    onSuccess: (r) => qc.setQueryData(key, r),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.records(route) });
    },
  });

  const current = rec.stage;
  if (!current) return null;
  if (!stages.length) return <StageBadge name={current.name} color={current.color} />;

  const needsReason = (s: StageDto) => isDeal && s.isLost && settings.deals.lostReasons.length > 0;
  const currentIndex = stages.findIndex((s) => s.uuid === current.uuid);

  const choose = (stage: StageDto) => {
    if (stage.uuid === current.uuid) return;
    if (needsReason(stage)) return setLostFor(stage);
    const from = stages[currentIndex];
    const toastId = toast.success(`Moved to ${stage.name}`, {
      // Going back into a lost stage would need a reason again, so only offer undo when it does not.
      action:
        stage.isWon && onConvert
          ? { label: 'Convert', onClick: onConvert }
          : from && !needsReason(from)
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
          const isCurrent = s.uuid === current.uuid;
          const done = !current.isLost && currentIndex >= 0 && i < currentIndex;
          return (
            <li key={s.uuid} className="shrink-0" style={stageStyle(s.color)}>
              <button
                type="button"
                disabled={!canMove}
                aria-current={isCurrent ? 'step' : undefined}
                onClick={() => choose(s)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-xs font-medium whitespace-nowrap transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.97] disabled:cursor-default pointer-coarse:h-10',
                  isCurrent && 'bg-(--sc) text-(--sc-fg)',
                  !isCurrent && done && 'stage-soft text-ink',
                  !isCurrent && !done && 'bg-subtle text-muted',
                  !isCurrent && canMove && 'hover:bg-hover hover:text-ink',
                )}
              >
                {!isCurrent ? (
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-(--sc)" />
                ) : null}
                {s.name}
              </button>
            </li>
          );
        })}
      </ol>
      {rec.stageEnteredAt ? (
        <p className="mt-1 text-xs text-muted">
          Entered {current.name} {formatRelative(rec.stageEnteredAt)}
        </p>
      ) : null}
      {lostFor && isDeal ? (
        <LostReasonDialog
          deal={props.deal}
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
