import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { GripVertical, ListChecks, Plus, X } from 'lucide-react';
import type { ChecklistItemDto } from '@app/shared';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { qk } from '@/lib/query-keys';

const checklistKey = (uuid: string) => ['records', 'activities', 'checklist', uuid] as const;

/** "2/5" progress chip for lists and board cards. */
export function ChecklistProgress({ checklist }: { checklist: { done: number; total: number } }) {
  if (!checklist.total) return null;
  const complete = checklist.done === checklist.total;
  return (
    <span
      className={cn('tabular inline-flex items-center gap-1 text-xs', complete ? 'text-muted' : 'text-ink')}
      aria-label={`Checklist ${checklist.done} of ${checklist.total} done`}
    >
      <ListChecks className="size-3" /> {checklist.done}/{checklist.total}
    </span>
  );
}

function Item({
  item,
  editable,
  onToggle,
  onRename,
  onRemove,
}: {
  item: ChecklistItemDto;
  editable: boolean;
  onToggle: (done: boolean) => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.uuid });
  const [label, setLabel] = useState(item.label);
  useEffect(() => setLabel(item.label), [item.label]);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="group flex items-center gap-2 bg-surface py-1"
    >
      {editable ? (
        <button
          type="button"
          className="cursor-grab text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Reorder ${item.label}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      ) : null}
      <Checkbox
        checked={item.done}
        disabled={!editable}
        onCheckedChange={(v) => onToggle(v)}
        aria-label={item.done ? `Untick ${item.label}` : `Tick ${item.label}`}
      />
      {editable ? (
        <input
          value={label}
          aria-label="Item"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() && label !== item.label && onRename(label.trim())}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className={cn(
            'min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary',
            item.done && 'text-muted line-through',
          )}
        />
      ) : (
        <span className={cn('flex-1 text-sm', item.done && 'text-muted line-through')}>{item.label}</span>
      )}
      {editable ? (
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Remove ${item.label}`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onRemove}
        >
          <X />
        </Button>
      ) : null}
    </li>
  );
}

/** Subtasks on one task: add, tick, rename, reorder and remove. */
export function TaskChecklist({ taskUuid, editable }: { taskUuid: string; editable: boolean }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const q = useQuery({
    queryKey: checklistKey(taskUuid),
    queryFn: () =>
      apiGet<{ data: ChecklistItemDto[] }>(`/activities/${taskUuid}/checklist`).then((r) => r.data),
  });
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: checklistKey(taskUuid) });
    void qc.invalidateQueries({ queryKey: qk.record('activities', taskUuid) });
    void qc.invalidateQueries({ queryKey: ['records', 'activities', 'list'] });
  };
  const setItems = (fn: (items: ChecklistItemDto[]) => ChecklistItemDto[]) =>
    qc.setQueryData<ChecklistItemDto[]>(checklistKey(taskUuid), (old) => fn(old ?? []));
  const add = useMutation({
    mutationFn: () => apiPost<ChecklistItemDto>(`/activities/${taskUuid}/checklist`, { label }),
    onSuccess: (item) => {
      setLabel('');
      setItems((items) => [...items, item]);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ uuid, body }: { uuid: string; body: { done?: boolean; label?: string } }) =>
      apiPatch<ChecklistItemDto>(`/activities/checklist/${uuid}`, body),
    // Ticking is instant; the server's answer (who ticked, when) replaces the guess.
    onMutate: ({ uuid, body }) =>
      setItems((items) => items.map((i) => (i.uuid === uuid ? { ...i, ...body } : i))),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/activities/checklist/${uuid}`),
    onMutate: (uuid) => setItems((items) => items.filter((i) => i.uuid !== uuid)),
    onSettled: refresh,
  });
  const reorder = useMutation({
    mutationFn: (uuids: string[]) => apiPut(`/activities/${taskUuid}/checklist/order`, { uuids }),
    onSettled: refresh,
  });
  const onDragEnd = (e: DragEndEvent) => {
    const items = q.data ?? [];
    if (!e.over || e.active.id === e.over.id) return;
    const ids = items.map((i) => i.uuid);
    const next = arrayMove(items, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setItems(() => next);
    reorder.mutate(next.map((i) => i.uuid));
  };

  if (q.isPending) return <Skeleton className="h-16" />;
  const items = q.data ?? [];
  const done = items.filter((i) => i.done).length;
  return (
    <div>
      {items.length ? (
        <>
          <div className="mb-2 flex items-center gap-2">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle"
              role="progressbar"
              aria-label="Checklist progress"
              aria-valuemin={0}
              aria-valuemax={items.length}
              aria-valuenow={done}
            >
              <div
                className="h-full bg-primary transition-[width] duration-200 ease-out"
                style={{ width: `${(done / items.length) * 100}%` }}
              />
            </div>
            <span className="tabular text-xs text-muted">
              {done}/{items.length}
            </span>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((i) => i.uuid)} strategy={verticalListSortingStrategy}>
              <ul>
                {items.map((item) => (
                  <Item
                    key={item.uuid}
                    item={item}
                    editable={editable}
                    onToggle={(v) => update.mutate({ uuid: item.uuid, body: { done: v } })}
                    onRename={(l) => update.mutate({ uuid: item.uuid, body: { label: l } })}
                    onRemove={() => remove.mutate(item.uuid)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </>
      ) : null}
      {editable ? (
        <form
          className="mt-1 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) add.mutate();
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Add an item"
            aria-label="New checklist item"
          />
          <Button type="submit" size="sm" disabled={!label.trim()} loading={add.isPending}>
            <Plus /> Add
          </Button>
        </form>
      ) : !items.length ? (
        <p className="text-sm text-muted">No checklist.</p>
      ) : null}
    </div>
  );
}
