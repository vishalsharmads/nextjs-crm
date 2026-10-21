import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
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
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { CUSTOMIZABLE_ENTITIES, type CustomizableEntity, type LayoutSection } from '@app/shared';
import { apiPut } from '@/lib/api';
import { labelVars } from '@/lib/labels';
import { bootstrapKey, useBoot, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Pane, Tabs, TabsList, TabsTrigger } from '@/components/ui/misc';
import { buildConfig, type FieldConfig } from '@/features/records/entities';
import { useFormSections } from '@/features/records/record-form';
import { SettingsPage } from './layout';

const refOf = (f: FieldConfig) => (f.def ? `cf.${f.def.key}` : f.input!);

/** Arrange form sections and pick default list columns per record type. */
export function LayoutBuilderPage() {
  const t = useT();
  const boot = useBoot();
  const L = labelVars(boot.labels);
  const [entity, setEntity] = useState<CustomizableEntity>('contact');
  return (
    <SettingsPage
      title={t('settings.layouts')}
      description="Choose which fields appear where. Forms and record pages use these sections; lists start with these columns."
    >
      <Tabs value={entity} onValueChange={(v) => setEntity(v as CustomizableEntity)}>
        <TabsList>
          {CUSTOMIZABLE_ENTITIES.filter(
            (e) => e !== 'activity' && (e !== 'lead' || boot.settings.features.leads),
          ).map((e) => (
            <TabsTrigger key={e} value={e}>
              {L[`${e}Plural`]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <EntityLayout key={entity} entity={entity} />
    </SettingsPage>
  );
}

function EntityLayout({ entity }: { entity: CustomizableEntity }) {
  const boot = useBoot();
  const qc = useQueryClient();
  const config = useMemo(() => buildConfig(entity, boot), [entity, boot]);
  const current = useFormSections(config);
  const [sections, setSections] = useState<LayoutSection[]>([]);
  useEffect(
    () => setSections(current.map((s) => ({ key: s.key, label: s.label, fields: s.fields.map(refOf) }))),
    [current],
  );
  const byRef = useMemo(
    () => new Map(config.fields.filter((f) => f.input || f.def).map((f) => [refOf(f), f])),
    [config],
  );
  const listColumns =
    boot.layouts.find((l) => l.entity === entity && l.context === 'list')?.columns ?? config.defaultColumns;
  const [columns, setColumns] = useState<string[]>(listColumns);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const save = useMutation({
    mutationFn: async () => {
      await apiPut('/layouts', {
        entity,
        context: 'form',
        sections: sections.filter((s) => s.fields.length),
      });
      await apiPut('/layouts', { entity, context: 'list', columns });
    },
    onSuccess: () => {
      toast.success('Layout saved');
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const from = sections.findIndex((s) => s.fields.includes(String(e.active.id)));
    const overId = String(e.over.id);
    const to = overId.startsWith('section:')
      ? sections.findIndex((s) => `section:${s.key}` === overId)
      : sections.findIndex((s) => s.fields.includes(overId));
    if (from < 0 || to < 0) return;
    const next = sections.map((s) => ({ ...s, fields: [...s.fields] }));
    if (from === to) {
      const f = next[from]!;
      f.fields = arrayMove(
        f.fields,
        f.fields.indexOf(String(e.active.id)),
        Math.max(f.fields.indexOf(overId), 0),
      );
    } else {
      next[from]!.fields = next[from]!.fields.filter((x) => x !== e.active.id);
      const idx = next[to]!.fields.indexOf(overId);
      next[to]!.fields.splice(idx < 0 ? next[to]!.fields.length : idx, 0, String(e.active.id));
    }
    setSections(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <Pane
        title="Form and record page"
        actions={
          <Button
            size="sm"
            onClick={() =>
              setSections([
                ...sections,
                { key: `section_${sections.length + 1}`, label: 'New section', fields: [] },
              ])
            }
          >
            <Plus /> Section
          </Button>
        }
      >
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
          <div className="grid gap-4 md:grid-cols-2">
            {sections.map((s, i) => (
              <SectionBox
                key={s.key}
                section={s}
                byRef={byRef}
                onRename={(label) => setSections(sections.map((x, j) => (j === i ? { ...x, label } : x)))}
                onRemove={() =>
                  setSections(
                    sections
                      .filter((_, j) => j !== i)
                      .map((x, j) => (j === 0 ? { ...x, fields: [...x.fields, ...s.fields] } : x)),
                  )
                }
                removable={sections.length > 1}
              />
            ))}
          </div>
        </DndContext>
        <p className="mt-3 text-xs text-muted">
          Drag fields between sections. Fields left out of every section appear in an “Other” section.
        </p>
      </Pane>
      <Pane title="Default list columns">
        <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {config.fields
            .filter((f) => !f.formOnly)
            .map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={columns.includes(f.key)}
                  onCheckedChange={(v) =>
                    setColumns(v ? [...columns, f.key] : columns.filter((c) => c !== f.key))
                  }
                  aria-label={f.label}
                />
                {f.label}
              </label>
            ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          People can still change their own columns; this is where new users start.
        </p>
      </Pane>
      <div>
        <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
          Save layout
        </Button>
      </div>
    </div>
  );
}

function SectionBox({
  section,
  byRef,
  onRename,
  onRemove,
  removable,
}: {
  section: LayoutSection;
  byRef: Map<string, FieldConfig>;
  onRename: (l: string) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `section:${section.key}` });
  return (
    <section
      ref={setNodeRef}
      className={`rounded-md border p-3 ${isOver ? 'border-primary bg-primary-soft' : 'border-line bg-subtle'}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Input
          aria-label="Section name"
          value={section.label}
          onChange={(e) => onRename(e.target.value)}
          className="h-7 text-sm font-medium"
        />
        {removable ? (
          <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${section.label}`}>
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <SortableContext items={section.fields} strategy={verticalListSortingStrategy}>
        <ul className="flex min-h-10 flex-col gap-1">
          {section.fields.map((ref) => (
            <FieldChip
              key={ref}
              id={ref}
              label={byRef.get(ref)?.label ?? ref}
              custom={ref.startsWith('cf.')}
            />
          ))}
        </ul>
      </SortableContext>
    </section>
  );
}

function FieldChip({ id, label, custom }: { id: string; label: string; custom: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-sm border border-line bg-surface px-2 py-1.5 text-sm ${isDragging ? 'opacity-50' : ''}`}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-3.5 text-faint" />
      <span className="flex-1 truncate">{label}</span>
      {custom ? <span className="text-2xs text-faint">custom</span> : null}
    </li>
  );
}
