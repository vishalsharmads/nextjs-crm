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
import { STAGE_COLORS, stageColor, type PipelineDto, type StageDto } from '@app/shared';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';
import { bootstrapKey, useBoot, useT } from '@/app/session';
import { labelVars } from '@/lib/labels';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, Pane, Skeleton, Tabs, TabsList, TabsTrigger } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/checkbox';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { StageDot } from '@/components/data/stage-color';
import { SettingsPage } from './layout';

export function PipelinesPage() {
  const t = useT();
  const qc = useQueryClient();
  const pipelines = useQuery({
    queryKey: ['pipelines', 'all'],
    queryFn: () => apiGet<{ data: PipelineDto[] }>('/pipelines?all=true').then((r) => r.data),
  });
  const boot = useBoot();
  const L = labelVars(boot.labels);
  const leadPipelines = boot.settings.features.leads && boot.settings.features.leadPipeline;
  const [entity, setEntity] = useState<'deal' | 'lead'>('deal');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const shown = pipelines.data?.filter((p) => p.entity === (leadPipelines ? entity : 'deal'));
  const current = shown?.find((p) => p.uuid === selected) ?? shown?.[0];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['pipelines'] });
    void qc.invalidateQueries({ queryKey: bootstrapKey });
    void qc.invalidateQueries({ queryKey: ['records', 'deals'] });
    void qc.invalidateQueries({ queryKey: ['records', 'leads'] });
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
      {leadPipelines ? (
        <Tabs value={entity} onValueChange={(v) => (setEntity(v as 'deal' | 'lead'), setSelected(null))}>
          <TabsList>
            <TabsTrigger value="deal">{L.dealPlural}</TabsTrigger>
            <TabsTrigger value="lead">{L.leadPlural}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {pipelines.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <nav className="flex flex-col gap-1" aria-label="Pipelines">
            {shown?.map((p) => (
              <button
                key={p.uuid}
                type="button"
                onClick={() => setSelected(p.uuid)}
                className={`flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-start text-sm ${current?.uuid === p.uuid ? 'bg-primary-soft font-medium' : 'hover:bg-hover'}`}
              >
                <span className={`truncate ${p.active ? '' : 'text-muted'}`}>{p.name}</span>
                {!p.active ? (
                  <Badge>Disabled</Badge>
                ) : p.isDefault ? (
                  <Star className="size-3.5 shrink-0 text-primary" aria-label="Default" />
                ) : null}
              </button>
            ))}
          </nav>
          {current ? (
            <PipelineEditor
              key={current.uuid}
              pipeline={current}
              others={(shown ?? []).filter((p) => p.active && p.uuid !== current.uuid)}
              onChanged={refresh}
            />
          ) : null}
        </div>
      )}
      {creating ? (
        <NewPipelineDialog
          entity={leadPipelines ? entity : 'deal'}
          onClose={() => setCreating(false)}
          onCreated={(uuid) => (refresh(), setSelected(uuid))}
        />
      ) : null}
    </SettingsPage>
  );
}

function PipelineEditor({
  pipeline,
  others,
  onChanged,
}: {
  pipeline: PipelineDto;
  others: PipelineDto[];
  onChanged: () => void;
}) {
  const [name, setName] = useState(pipeline.name);
  const [disabling, setDisabling] = useState(false);
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
  const turnOn = useMutation({
    mutationFn: () => apiPatch(`/pipelines/${pipeline.uuid}`, { active: true }),
    onSuccess: () => {
      toast.success(`${pipeline.name} turned on`);
      onChanged();
    },
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
        !pipeline.active ? (
          <Button size="sm" loading={turnOn.isPending} onClick={() => turnOn.mutate()}>
            Turn on
          </Button>
        ) : pipeline.isDefault ? (
          <Badge tone="primary">Default</Badge>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => rename.mutate({ isDefault: true })}>
              Make default
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDisabling(true)}>
              Disable
            </Button>
          </div>
        )
      }
      padded={false}
    >
      <div className="grid grid-cols-[20px_28px_minmax(7rem,1fr)_60px_80px_112px_28px] items-center gap-2 border-b border-line bg-subtle px-3 py-2 text-xs font-medium text-muted">
        <span />
        <span>
          <span className="sr-only">Color</span>
        </span>
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
      {!pipeline.active ? (
        <p className="border-b border-line bg-subtle px-3 py-2 text-sm text-muted">
          Disabled: hidden from boards, filters and new records. Its stages and stage history are kept.
        </p>
      ) : null}
      {disabling ? (
        <DisablePipelineDialog
          pipeline={pipeline}
          others={others}
          onClose={() => setDisabling(false)}
          onDone={onChanged}
        />
      ) : null}
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
      className="grid grid-cols-[20px_28px_minmax(7rem,1fr)_60px_80px_112px_28px] items-center gap-2 bg-surface px-3 py-2"
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
      <StageColorPicker stage={stage} onPick={(color) => onUpdate({ color })} />
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

const colorName = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);

function StageColorPicker({ stage, onPick }: { stage: StageDto; onPick: (color: string) => void }) {
  const current = stageColor(stage.color);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Color of ${stage.name}: ${colorName(current)}`}
          className="flex size-7 items-center justify-center rounded-sm hover:bg-hover"
        >
          <StageDot color={current} className="size-3.5" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="min-w-36">
        {STAGE_COLORS.map((c) => (
          <MenuItem key={c} onSelect={() => c !== current && onPick(c)}>
            <StageDot color={c} className="size-3" />
            <span className={c === current ? 'font-medium' : undefined}>{colorName(c)}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
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

function DisablePipelineDialog({
  pipeline,
  others,
  onClose,
  onDone,
}: {
  pipeline: PipelineDto;
  others: PipelineDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [moveTo, setMoveTo] = useState(others[0]?.stages[0]?.uuid ?? '');
  const disable = useMutation({
    mutationFn: () => apiPatch(`/pipelines/${pipeline.uuid}`, { active: false, moveTo: moveTo || undefined }),
    onSuccess: () => {
      toast.success(`${pipeline.name} disabled`);
      onDone();
      onClose();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not disable'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Disable ${pipeline.name}?`}
        description="Records on it move to the stage you choose. You can turn it back on later; its stages and history are kept."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" loading={disable.isPending} onClick={() => disable.mutate()}>
              Disable pipeline
            </Button>
          </>
        }
      >
        <Field label="Move records to">
          {(p) => (
            <NativeSelect {...p} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              {others.map((o) => (
                <optgroup key={o.uuid} label={o.name}>
                  {o.stages.map((s) => (
                    <option key={s.uuid} value={s.uuid}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </NativeSelect>
          )}
        </Field>
      </DialogContent>
    </Dialog>
  );
}

function NewPipelineDialog({
  entity,
  onClose,
  onCreated,
}: {
  entity: 'deal' | 'lead';
  onClose: () => void;
  onCreated: (uuid: string) => void;
}) {
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const create = useMutation({
    mutationFn: () => apiPost<PipelineDto>('/pipelines', { name, isDefault, entity }),
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
