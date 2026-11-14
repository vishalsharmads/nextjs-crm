import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Plus, ScanSearch, Trash2 } from 'lucide-react';
import {
  DUPLICATE_ENTITIES,
  DUPLICATE_FIELDS,
  type DuplicateEntity,
  type DuplicateRuleDto,
} from '@app/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { useFields, useLabel } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/checkbox';
import { confirmAction } from '@/components/ui/confirm';
import { SettingsPage } from './layout';

const KEY = ['duplicate-rules'] as const;

/** Rule fields a record type can compare: its standard ones plus filterable, non-sensitive custom fields. */
function useRuleFields(entity: DuplicateEntity) {
  const custom = useFields(entity)
    .filter(
      (f) =>
        f.filterable &&
        f.sensitivity !== 'special' &&
        ['text', 'email', 'phone', 'url', 'number', 'select'].includes(f.type),
    )
    .map((f) => ({ key: `cf:${f.key}`, label: f.label }));
  return [...DUPLICATE_FIELDS[entity], ...custom];
}

/** Settings → Duplicate rules: what makes two records the same, and whether to warn or refuse. */
export function DuplicateRulesPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => apiGet<{ data: DuplicateRuleDto[] }>('/duplicates/rules').then((r) => r.data),
  });
  const [editing, setEditing] = useState<DuplicateRuleDto | DuplicateEntity | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const patch = useMutation({
    mutationFn: ({ uuid, ...body }: Partial<DuplicateRuleDto> & { uuid: string }) =>
      apiPatch(`/duplicates/rules/${uuid}`, body),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/duplicates/rules/${uuid}`),
    onSuccess: () => {
      toast.success('Deleted');
      refresh();
    },
  });
  const scan = useMutation({
    mutationFn: () => apiPost<{ added: number }>('/duplicates/scan'),
    onSuccess: (r) =>
      toast.success(r.added ? `Scanned: ${r.added} new possible duplicates` : 'Scanned: nothing new found'),
  });
  return (
    <SettingsPage
      title="Duplicate rules"
      description="Which fields must match for two records to be the same. Matches are shown while someone creates a record, and a nightly scan fills the merge queue."
      actions={
        <>
          <Button asChild>
            <Link to="/duplicates">
              <Copy /> Merge queue
            </Link>
          </Button>
          <Button onClick={() => scan.mutate()} loading={scan.isPending}>
            <ScanSearch /> Scan now
          </Button>
        </>
      }
    >
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        DUPLICATE_ENTITIES.map((entity) => (
          <EntityRules
            key={entity}
            entity={entity}
            rules={q.data.filter((r) => r.entity === entity)}
            onAdd={() => setEditing(entity)}
            onEdit={setEditing}
            onToggle={(r) => patch.mutate({ uuid: r.uuid, active: !r.active })}
            onDelete={(r) =>
              void confirmAction({
                title: `Delete the rule “${r.name}”?`,
                action: 'Delete',
                danger: true,
              }).then((ok) => ok && remove.mutate(r.uuid))
            }
          />
        ))
      )}
      {editing ? <RuleDialog value={editing} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
    </SettingsPage>
  );
}

function EntityRules({
  entity,
  rules,
  onAdd,
  onEdit,
  onToggle,
  onDelete,
}: {
  entity: DuplicateEntity;
  rules: DuplicateRuleDto[];
  onAdd: () => void;
  onEdit: (r: DuplicateRuleDto) => void;
  onToggle: (r: DuplicateRuleDto) => void;
  onDelete: (r: DuplicateRuleDto) => void;
}) {
  const label = useLabel(entity);
  const fields = useRuleFields(entity);
  const name = (k: string) => fields.find((f) => f.key === k)?.label ?? k;
  return (
    <Pane
      title={label.plural}
      padded={false}
      actions={
        <Button size="sm" onClick={onAdd}>
          <Plus /> Add rule
        </Button>
      }
    >
      {!rules.length ? (
        <EmptyState title="No rules" description="Without rules, duplicates are not looked for." />
      ) : (
        <ul className="divide-y divide-line">
          {rules.map((r) => (
            <li key={r.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <Switch
                checked={r.active}
                onCheckedChange={() => onToggle(r)}
                aria-label={`${r.name} turned ${r.active ? 'on' : 'off'}`}
              />
              <button type="button" className="min-w-0 flex-1 text-start" onClick={() => onEdit(r)}>
                <span className="font-medium">{r.name}</span>
                <span className="ms-2 text-muted">{r.fields.map(name).join(' + ')}</span>
              </button>
              <Badge tone={r.action === 'block' ? 'accent' : 'neutral'}>
                {r.action === 'block' ? 'Refuses the save' : 'Warns'}
              </Badge>
              <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => onDelete(r)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

function RuleDialog({
  value,
  onClose,
  onSaved,
}: {
  value: DuplicateRuleDto | DuplicateEntity;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = typeof value === 'string' ? null : value;
  const entity = existing?.entity ?? (value as DuplicateEntity);
  const fields = useRuleFields(entity);
  const [name, setName] = useState(existing?.name ?? '');
  const [chosen, setChosen] = useState<string[]>(existing?.fields ?? []);
  const [action, setAction] = useState<'warn' | 'block'>(existing?.action ?? 'warn');
  const save = useMutation({
    mutationFn: () =>
      existing
        ? apiPatch(`/duplicates/rules/${existing.uuid}`, { name, fields: chosen, action })
        : apiPost('/duplicates/rules', { entity, name, fields: chosen, action }),
    onSuccess: () => {
      toast.success('Saved');
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={existing ? 'Edit rule' : 'New duplicate rule'}
        description="Two records are the same when every chosen field matches (case and spaces are ignored)."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!name.trim() || !chosen.length}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name">
            {(p) => (
              <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Same email" />
            )}
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">Fields that must match</legend>
            {fields.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(f.key)}
                  onChange={(e) =>
                    setChosen(e.target.checked ? [...chosen, f.key] : chosen.filter((k) => k !== f.key))
                  }
                  disabled={!chosen.includes(f.key) && chosen.length >= 4}
                />
                {f.label}
              </label>
            ))}
          </fieldset>
          <Field label="When it matches">
            {(p) => (
              <NativeSelect
                {...p}
                value={action}
                onChange={(e) => setAction(e.target.value as 'warn' | 'block')}
              >
                <option value="warn">Warn, and let people save anyway</option>
                <option value="block">Refuse the save</option>
              </NativeSelect>
            )}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}
