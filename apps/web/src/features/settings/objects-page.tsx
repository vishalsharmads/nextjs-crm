import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Plus, Shapes } from 'lucide-react';
import {
  MAX_CUSTOM_OBJECTS,
  OBJECT_ICONS,
  OBJECT_LINK_TARGETS,
  type CustomObjectDto,
  type ObjectLinkTarget,
} from '@app/shared';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { bootstrapKey, useBoot, useT } from '@/app/session';
import { moduleIcon } from '@/app/shell/nav';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SettingsPage } from './layout';

const objectsKey = ['objects'] as const;

/** `Service visit` → `service_visit`. */
const toKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 32);

export function ObjectsPage() {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CustomObjectDto | 'new' | null>(null);
  const objects = useQuery({
    queryKey: objectsKey,
    queryFn: () => apiGet<{ data: CustomObjectDto[] }>('/objects').then((r) => r.data),
  });
  const archive = useMutation({
    mutationFn: (o: CustomObjectDto) => apiPost(`/objects/${o.uuid}/${o.archived ? 'restore' : 'archive'}`),
    onSuccess: (_r, o) => {
      toast.success(o.archived ? 'Restored' : 'Archived. Its records are kept.');
      void qc.invalidateQueries({ queryKey: objectsKey });
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });
  const full = (objects.data?.length ?? 0) >= MAX_CUSTOM_OBJECTS;
  return (
    <SettingsPage
      title={t('settings.objects')}
      description="Track things your industry needs that are not built in, such as properties, vehicles or equipment. Each object gets its own list, record pages, fields, views, search, import and permissions."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')} disabled={full}>
          <Plus /> New object
        </Button>
      }
    >
      <Pane padded={false}>
        {objects.isPending ? (
          <Skeleton className="m-4 h-24" />
        ) : objects.isError ? (
          <ErrorState error={objects.error} onRetry={() => void objects.refetch()} />
        ) : !objects.data.length ? (
          <EmptyState
            icon={<Shapes />}
            title="No objects yet"
            description="Create an object to keep records of something specific to your work."
            action={<Button onClick={() => setEditing('new')}>Create an object</Button>}
          />
        ) : (
          <ul className="divide-y divide-line">
            {objects.data.map((o) => {
              const Icon = moduleIcon(o.icon);
              return (
                <li key={o.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Icon className="size-4 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {o.plural}
                      {o.archived ? <Badge>Archived</Badge> : null}
                      {o.fromBlueprint ? <Badge tone="outline">Preset</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-muted">{o.description || `/${o.route}`}</p>
                  </div>
                  {!o.archived ? (
                    <>
                      <Button size="sm" variant="ghost" asChild>
                        <Link to={`/settings/fields?entity=${o.key}`}>Fields</Link>
                      </Button>
                      <Button size="sm" variant="ghost" asChild>
                        <Link to={`/o/${o.route}`}>Open</Link>
                      </Button>
                      <Button size="sm" onClick={() => setEditing(o)}>
                        Edit
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => archive.mutate(o)}
                    aria-label={`${o.archived ? 'Restore' : 'Archive'} ${o.plural}`}
                  >
                    {o.archived ? <ArchiveRestore /> : <Archive />}
                    {o.archived ? 'Restore' : 'Archive'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Pane>
      {full ? (
        <p className="text-sm text-muted">You have reached the limit of {MAX_CUSTOM_OBJECTS} objects.</p>
      ) : null}
      {editing ? (
        <ObjectDialog object={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsPage>
  );
}

function ObjectDialog({ object, onClose }: { object: CustomObjectDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { labels } = useBoot();
  const [singular, setSingular] = useState(object?.singular ?? '');
  const [plural, setPlural] = useState(object?.plural ?? '');
  const [key, setKey] = useState(object?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(false);
  const [icon, setIcon] = useState(object?.icon ?? 'box');
  const [description, setDescription] = useState(object?.description ?? '');
  const [links, setLinks] = useState<ObjectLinkTarget[]>(object?.links ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const body = { singular, plural, icon, description: description || null, links };
      return object ? apiPatch(`/objects/${object.uuid}`, body) : apiPost('/objects', { ...body, key });
    },
    onSuccess: () => {
      toast.success(object ? 'Saved' : 'Created');
      void qc.invalidateQueries({ queryKey: objectsKey });
      void qc.invalidateQueries({ queryKey: bootstrapKey });
      onClose();
    },
    onError: (err) => {
      const fields = err instanceof ApiError ? err.fieldErrors() : {};
      if (Object.keys(fields).length) setErrors(fields);
      else toast.error(err instanceof ApiError ? err.message : 'Could not save the object');
    },
  });
  const onSingular = (v: string) => {
    setSingular(v);
    if (!object && !keyTouched) setKey(toKey(v));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={object ? `Edit ${object.plural}` : 'New object'}
        description={
          object ? undefined : 'Records get a name, an owner, and any fields you add next in Custom fields.'
        }
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!singular.trim() || !plural.trim() || !key}
            >
              {object ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Singular name" required error={errors.singular}>
              {(p) => (
                <Input
                  {...p}
                  value={singular}
                  onChange={(e) => onSingular(e.target.value)}
                  placeholder="Vehicle"
                  autoFocus
                />
              )}
            </Field>
            <Field label="Plural name" required error={errors.plural}>
              {(p) => (
                <Input
                  {...p}
                  value={plural}
                  onChange={(e) => setPlural(e.target.value)}
                  placeholder="Vehicles"
                />
              )}
            </Field>
          </div>
          <Field
            label="Key"
            required
            error={errors.key}
            help={
              object
                ? 'The key is fixed once the object exists.'
                : 'Used in the API and in links. It cannot be changed later.'
            }
          >
            {(p) => (
              <Input
                {...p}
                value={key}
                disabled={!!object}
                onChange={(e) => {
                  setKeyTouched(true);
                  setKey(toKey(e.target.value));
                }}
              />
            )}
          </Field>
          <Field label="Icon">
            {(p) => (
              <NativeSelect {...p} value={icon} onChange={(e) => setIcon(e.target.value)}>
                {OBJECT_ICONS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Description">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium text-muted">Link each record to</legend>
            {OBJECT_LINK_TARGETS.map((target) => {
              const locked = !!object?.links.includes(target);
              return (
                <label key={target} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={links.includes(target)}
                    disabled={locked}
                    onCheckedChange={(on) =>
                      setLinks((cur) => (on ? [...cur, target] : cur.filter((l) => l !== target)))
                    }
                  />
                  {labels[target]?.singular ?? target}
                  {locked ? <span className="text-xs text-faint">Links cannot be removed</span> : null}
                </label>
              );
            })}
          </fieldset>
        </div>
      </DialogContent>
    </Dialog>
  );
}
