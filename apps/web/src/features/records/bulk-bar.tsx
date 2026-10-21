import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Tag, Trash2, UserRound, X, PencilLine, ArrowRightLeft } from 'lucide-react';
import type { FilterCondition } from '@app/shared';
import { apiPost } from '@/lib/api';
import { useCan, usePipelines } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Combobox } from '@/components/fields/combobox';
import { TagsInput, UserPicker } from '@/components/fields/pickers';
import type { EntityConfig, FieldConfig } from './entities';
import { FieldInputControl } from './record-form';
import { useForm } from 'react-hook-form';

type Action = 'assign' | 'add_tags' | 'remove_tags' | 'update_field' | 'move_stage' | 'delete';

/** Floating bulk action bar. "Select all matching" acts on the whole filtered list, not just this page. */
export function BulkBar({
  config,
  selected,
  onClear,
  total,
  allMatching,
  onSelectAllMatching,
  criteria,
}: {
  config: EntityConfig;
  selected: Set<string>;
  onClear: () => void;
  total?: number;
  allMatching?: boolean;
  onSelectAllMatching?: () => void;
  criteria?: { conditions: FilterCondition[]; q: string; view: string | null };
}) {
  const can = useCan();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Action | null>(null);
  const count = allMatching ? (total ?? selected.size) : selected.size;
  const run = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPost<{ affected: number; failed: number }>(`/${config.route}/bulk`, {
        ...body,
        ...(allMatching
          ? {
              all: true,
              filter: criteria?.conditions.length ? { and: criteria.conditions } : undefined,
              q: criteria?.q || undefined,
              view: criteria?.view || undefined,
            }
          : { uuids: [...selected] }),
      }),
    onSuccess: (r, body) => {
      if (r.failed) toast.warning(`${r.affected} updated, ${r.failed} could not be changed`);
      else
        toast.success(
          `${r.affected} ${r.affected === 1 ? config.singular.toLowerCase() : config.plural.toLowerCase()} ${body.action === 'delete' ? 'deleted' : 'updated'}`,
        );
      void qc.invalidateQueries({ queryKey: ['records'] });
      setDialog(null);
      onClear();
    },
  });
  const p = (a: string) => can(`${config.resource}.${a}`);
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-line bg-primary-soft px-4 py-1.5 text-sm md:px-6"
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="font-medium tabular">{count.toLocaleString()} selected</span>
      {!allMatching && total && total > selected.size && onSelectAllMatching ? (
        <Button size="sm" variant="link" onClick={onSelectAllMatching}>
          Select all {total.toLocaleString()}
        </Button>
      ) : null}
      <div className="ms-2 flex flex-wrap items-center gap-1">
        {p('assign') ? (
          <Button size="sm" variant="ghost" onClick={() => setDialog('assign')}>
            <UserRound /> Assign
          </Button>
        ) : null}
        {p('update') ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDialog('add_tags')}>
              <Tag /> Tag
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog('update_field')}>
              <PencilLine /> Edit field
            </Button>
            {config.entity === 'deal' ? (
              <Button size="sm" variant="ghost" onClick={() => setDialog('move_stage')}>
                <ArrowRightLeft /> Move
              </Button>
            ) : null}
          </>
        ) : null}
        {p('delete') ? (
          <Button size="sm" variant="ghost" className="text-accent" onClick={() => setDialog('delete')}>
            <Trash2 /> Delete
          </Button>
        ) : null}
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        className="ms-auto"
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X />
      </Button>
      {dialog ? (
        <BulkDialog
          action={dialog}
          config={config}
          count={count}
          loading={run.isPending}
          onClose={() => setDialog(null)}
          onRun={(body) => run.mutate({ action: dialog, ...body })}
        />
      ) : null}
    </div>
  );
}

function BulkDialog({
  action,
  config,
  count,
  loading,
  onClose,
  onRun,
}: {
  action: Action;
  config: EntityConfig;
  count: number;
  loading: boolean;
  onClose: () => void;
  onRun: (body: Record<string, unknown>) => void;
}) {
  const [owner, setOwner] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<'add_tags' | 'remove_tags'>('add_tags');
  const [fieldKey, setFieldKey] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const pipelines = usePipelines('deal');
  const form = useForm<Record<string, unknown> & { custom: Record<string, unknown> }>({
    defaultValues: { custom: {} },
  });
  const editable = config.fields.filter(
    (f) =>
      (f.input &&
        !['tags', 'ownerUuid', 'organizationUuid', 'contactUuid', 'stageUuid', 'pipelineUuid'].includes(
          f.input,
        )) ||
      (f.def && f.def.level === 'write'),
  );
  const field: FieldConfig | undefined = editable.find((f) => f.key === fieldKey);
  const noun = count === 1 ? config.singular.toLowerCase() : config.plural.toLowerCase();

  const titles: Record<Action, string> = {
    assign: `Assign ${count} ${noun}`,
    add_tags: `Tag ${count} ${noun}`,
    remove_tags: `Tag ${count} ${noun}`,
    update_field: `Edit ${count} ${noun}`,
    move_stage: `Move ${count} ${noun}`,
    delete: `Delete ${count} ${noun}?`,
  };
  const submit = () => {
    if (action === 'assign') onRun({ ownerUuid: owner });
    else if (action === 'add_tags' || action === 'remove_tags') onRun({ action: tagMode, tags });
    else if (action === 'move_stage') onRun({ stageUuid: stage });
    else if (action === 'update_field' && field) {
      const values = form.getValues();
      onRun({
        field: field.def ? `cf.${field.def.key}` : field.input,
        value: field.def ? (values.custom?.[field.def.key] ?? null) : values[field.input!],
      });
    } else if (action === 'delete') onRun({});
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={titles[action]}
        description={action === 'delete' ? 'Deleted records can be restored from the trash.' : undefined}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant={action === 'delete' ? 'danger' : 'primary'}
              loading={loading}
              onClick={submit}
              disabled={
                (action === 'update_field' && !field) ||
                (action === 'move_stage' && !stage) ||
                ((action === 'add_tags' || action === 'remove_tags') && !tags.length)
              }
            >
              {action === 'delete' ? 'Delete' : 'Apply'}
            </Button>
          </>
        }
      >
        {action === 'assign' ? (
          <UserPicker
            value={owner}
            onChange={setOwner}
            placeholder="Choose an owner (or leave empty to unassign)"
          />
        ) : null}
        {action === 'add_tags' || action === 'remove_tags' ? (
          <div className="flex flex-col gap-3">
            <Combobox
              clearable={false}
              value={tagMode}
              onChange={(v) => setTagMode(v as typeof tagMode)}
              options={[
                { value: 'add_tags', label: 'Add tags' },
                { value: 'remove_tags', label: 'Remove tags' },
              ]}
            />
            <TagsInput value={tags} onChange={setTags} />
          </div>
        ) : null}
        {action === 'move_stage' ? (
          <Combobox
            value={stage}
            onChange={(v) => setStage(v as string)}
            options={pipelines.flatMap((p) =>
              p.stages.map((s) => ({
                value: s.uuid,
                label: pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name,
              })),
            )}
            placeholder="Choose a stage"
          />
        ) : null}
        {action === 'update_field' ? (
          <div className="flex flex-col gap-3">
            <Combobox
              value={fieldKey}
              onChange={(v) => setFieldKey(v as string)}
              options={editable.map((f) => ({ value: f.key, label: f.label }))}
              placeholder="Choose a field"
            />
            {field ? <FieldInputControl field={field} control={form.control} /> : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
