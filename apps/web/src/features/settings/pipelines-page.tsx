import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Star, Trash2 } from 'lucide-react';
import type { PipelineDto, StageDto } from '@app/shared';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';
import { bootstrapKey, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, Pane, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/checkbox';
import { SettingsPage } from './layout';

export function PipelinesPage() {
  const t = useT();
  const qc = useQueryClient();
  const pipelines = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => apiGet<{ data: PipelineDto[] }>('/pipelines').then((r) => r.data),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = pipelines.data?.find((p) => p.uuid === selected) ?? pipelines.data?.[0];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['pipelines'] });
    void qc.invalidateQueries({ queryKey: bootstrapKey });
    void qc.invalidateQueries({ queryKey: ['records', 'deals'] });
  };
  return (
    <SettingsPage
      title={t('settings.pipelines')}
      description="Stages, win probability and how long a record can sit in a stage before it is flagged as stalled."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus /> New pipeline
        </Button>
      }
    >
      {pipelines.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <nav className="flex flex-col gap-1" aria-label="Pipelines">
            {pipelines.data?.map((p) => (
              <button
                key={p.uuid}
                type="button"
                onClick={() => setSelected(p.uuid)}
                className={`flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-start text-sm ${current?.uuid === p.uuid ? 'bg-primary-soft font-medium' : 'hover:bg-hover'}`}
              >
                <span className="truncate">{p.name}</span>
                {p.isDefault ? (
                  <Star className="size-3.5 shrink-0 text-primary" aria-label="Default" />
                ) : null}
              </button>
            ))}
          </nav>
          {current ? <PipelineEditor key={current.uuid} pipeline={current} onChanged={refresh} /> : null}
        </div>
      )}
      {creating ? (
        <NewPipelineDialog
          onClose={() => setCreating(false)}
          onCreated={(uuid) => (refresh(), setSelected(uuid))}
        />
      ) : null}
    </SettingsPage>
  );
}

function PipelineEditor({ pipeline, onChanged }: { pipeline: PipelineDto; onChanged: () => void }) {
  const [name, setName] = useState(pipeline.name);
  const [stages, setStages] = useState(pipeline.stages);
  const [removing, setRemoving] = useState<StageDto | null>(null);
  const [newStage, setNewStage] = useState('');
  useEffect(() => setStages(pipeline.stages), [pipeline.stages]);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const rename = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPatch(`/pipelines/${pipeline.uuid}`, body),
    onSuccess: onChanged,
  });
  const reorder = useMutation({
    mutationFn: (uuids: string[]) =>
      apiPut(`/pipelines/${pipeline.uuid}/stages/order`, { stageUuids: uuids }),
    onSuccess: onChanged,
  });
  const addStage = useMutation({
    mutationFn: () =>
      apiPost(`/pipelines/${pipeline.uuid}/stages`, { name: newStage.trim(), probability: 50 }),
    onSuccess: () => {
      setNewStage('');
      onChanged();
    },
  });
  const updateStage = useMutation({
    mutationFn: ({ uuid, body }: { uuid: string; body: Record<string, unknown> }) =>
      apiPatch(`/pipelines/${pipeline.uuid}/stages/${uuid}`, body),
    onSuccess: onChanged,
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = stages.map((s) => s.uuid);
    const next = arrayMove(stages, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setStages(next);
    reorder.mutate(next.map((s) => s.uuid));
  };

  return (
    <Pane
      title={
        <input
          aria-label="Pipeline name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== pipeline.name && rename.mutate({ name })}
          className="w-full rounded-sm bg-transparent px-1 font-semibold outline-none focus:bg-hover"
        />
      }
      actions={
        pipeline.isDefault ? (
          <Badge tone="primary">Default</Badge>
        ) : (
          <Button size="sm" onClick={() => rename.mutate({ isDefault: true })}>
            Make default
          </Button>
        )
      }
      padded={false}
    >
      <div className="grid grid-cols-[24px_1fr_80px_90px_150px_32px] items-center gap-2 border-b border-line bg-subtle px-3 py-2 text-xs font-medium text-muted">
        <span />
        <span>Stage</span>
        <span>Win %</span>
        <span>Stalls after</span>
        <span>Outcome</span>
        <span />
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={stages.map((s) => s.uuid)} strategy={verticalListSortingStrategy}>
          <ul className="divide-y divide-line">
            {stages.map((s) => (
              <StageRow
                key={s.uuid}
                stage={s}
                onUpdate={(body) => updateStage.mutate({ uuid: s.uuid, body })}
                onRemove={() => setRemoving(s)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (newStage.trim()) addStage.mutate();
        }}
      >
        <Input
          value={newStage}
          onChange={(e) => setNewStage(e.target.value)}
          placeholder="New stage name"
          aria-label="New stage name"
        />
        <Button type="submit" loading={addStage.isPending} disabled={!newStage.trim()}>
          <Plus /> Add stage
        </Button>
      </form>
      {removing ? (
        <RemoveStageDialog
          pipeline={pipeline}
          stage={removing}
          onClose={() => setRemoving(null)}
          onDone={onChanged}
        />
      ) : null}
    </Pane>
  );
}

function StageRow({
  stage,
  onUpdate,
  onRemove,
}: {
  stage: StageDto;
  onUpdate: (body: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: stage.uuid });
  const [name, setName] = useState(stage.name);
  const [prob, setProb] = useState(String(stage.probability));
  const [rot, setRot] = useState(stage.rottingDays ? String(stage.rottingDays) : '');
  const outcome = stage.isWon ? 'won' : stage.isLost ? 'lost' : 'open';
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="grid grid-cols-[24px_1fr_80px_90px_150px_32px] items-center gap-2 bg-surface px-3 py-2"
    >
      <button
        type="button"
        className="cursor-grab text-faint hover:text-ink"
        aria-label={`Reorder ${stage.name}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <Input
        aria-label="Stage name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== stage.name && onUpdate({ name })}
        className="h-7"
      />
      <Input
        aria-label="Win probability"
        type="number"
        min={0}
        max={100}
        value={prob}
        disabled={outcome !== 'open'}
        onChange={(e) => setProb(e.target.value)}
        onBlur={() => Number(prob) !== stage.probability && onUpdate({ probability: Number(prob) })}
        className="h-7 tabular"
      />
      <div className="flex items-center gap-1">
        <Input
          aria-label="Days before stalled"
          type="number"
          min={1}
          value={rot}
          disabled={outcome !== 'open'}
          onChange={(e) => setRot(e.target.value)}
          onBlur={() => onUpdate({ rottingDays: rot ? Number(rot) : null })}
          className="h-7 tabular"
          placeholder="—"
        />
        <span className="text-xs text-muted">d</span>
      </div>
      <NativeSelect
        aria-label="Outcome"
        value={outcome}
        onChange={(e) => onUpdate({ isWon: e.target.value === 'won', isLost: e.target.value === 'lost' })}
        className="h-7 text-xs"
      >
        <option value="open">In progress</option>
        <option value="won">Won</option>
        <option value="lost">Lost</option>
      </NativeSelect>
      <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${stage.name}`}>
        <Trash2 />
      </Button>
    </li>
  );
}

function RemoveStageDialog({
  pipeline,
  stage,
  onClose,
  onDone,
}: {
  pipeline: PipelineDto;
  stage: StageDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const others = pipeline.stages.filter((s) => s.uuid !== stage.uuid);
  const [moveTo, setMoveTo] = useState(others[0]?.uuid ?? '');
  const remove = useMutation({
    mutationFn: (withMove: boolean) =>
      apiDelete(`/pipelines/${pipeline.uuid}/stages/${stage.uuid}${withMove ? `?moveTo=${moveTo}` : ''}`),
    onSuccess: () => {
      toast.success(`${stage.name} removed`);
      onDone();
      onClose();
    },
    onError: (err) => {
      if (!(err instanceof ApiError && err.code === 'VALIDATION_FAILED'))
        toast.error(err instanceof Error ? err.message : 'Could not remove');
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Remove ${stage.name}?`}
        description="Records in this stage move to the stage you choose. Stage history is kept."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(true)}>
              Remove stage
            </Button>
          </>
        }
      >
        <Field label="Move records to">
          {(p) => (
            <NativeSelect {...p} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              {others.map((s) => (
                <option key={s.uuid} value={s.uuid}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </DialogContent>
    </Dialog>
  );
}

function NewPipelineDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (uuid: string) => void;
}) {
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const create = useMutation({
    mutationFn: () => apiPost<PipelineDto>('/pipelines', { name, isDefault }),
    onSuccess: (p) => {
      toast.success('Pipeline created');
      onCreated(p.uuid);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="New pipeline"
        description="It starts with New, In progress, Won and Lost. Rename and add stages after."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              loading={create.isPending}
              disabled={!name.trim()}
            >
              Create pipeline
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" required>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <label className="flex items-center justify-between text-sm">
            Make this the default pipeline <Switch checked={isDefault} onCheckedChange={setIsDefault} />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
