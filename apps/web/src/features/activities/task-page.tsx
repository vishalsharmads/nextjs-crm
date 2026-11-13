import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Check, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { ENTITY_ROUTE, type ActivityDto, type ActivityType } from '@app/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { fromLocalInput, toLocalInput } from '@/lib/format';
import { useBranding } from '@/app/branding';
import { useCan, useLabel, useT } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { Badge, ErrorState, Skeleton } from '@/components/ui/misc';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { UserPicker } from '@/components/fields/pickers';
import { Timeline } from '@/features/records/timeline';
import { ACTIVITY_ICON } from './activity-components';

export const TASK_TYPE_LABEL: Record<Exclude<ActivityType, 'note' | 'email'>, string> = {
  task: 'Task',
  call: 'Call',
  meeting: 'Meeting',
};

export const taskKey = (uuid: string) => ['records', 'activities', 'detail', uuid] as const;

/** Patch one task and refresh every list that may show it. */
export function useTaskPatch(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPatch<ActivityDto>(`/activities/${uuid}`, body),
    onSuccess: (a) => {
      qc.setQueryData(taskKey(uuid), a);
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['records', 'activities'] });
    },
  });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-2 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The detail page for one task, call or meeting: edit in place, complete, discuss. */
export function TaskPage() {
  const { uuid = '' } = useParams();
  const t = useT();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { branding } = useBranding();
  const q = useQuery({
    queryKey: taskKey(uuid),
    queryFn: () => apiGet<ActivityDto>(`/activities/${uuid}`),
  });
  const patch = useTaskPatch(uuid);
  const editable = can('core.activities.update');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  useEffect(() => {
    if (q.data) {
      setSubject(q.data.subject);
      setBody(q.data.body ?? '');
    }
  }, [q.data]);
  useEffect(
    () => setDocumentTitle(q.data?.subject || t('nav.tasks'), branding.appName),
    [q.data?.subject, t, branding.appName],
  );
  const toggle = useMutation({
    mutationFn: (done: boolean) =>
      apiPost<ActivityDto>(`/activities/${uuid}/${done ? 'complete' : 'reopen'}`),
    onSuccess: (a, done) => {
      qc.setQueryData(taskKey(uuid), a);
      void qc.invalidateQueries({ queryKey: ['records', 'activities'] });
      void qc.invalidateQueries({ queryKey: ['activities'] });
      toast.success(done ? 'Completed' : 'Reopened');
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/activities/${uuid}`),
    onSuccess: () => {
      toast.success('Deleted');
      void qc.invalidateQueries({ queryKey: ['records', 'activities'] });
      navigate('/tasks');
    },
  });

  if (q.isPending)
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data;
  const done = !!a.completedAt;
  const Icon = ACTIVITY_ICON[a.type];
  const whenField = a.type === 'meeting' ? 'startAt' : 'dueAt';
  const when = a.type === 'meeting' ? a.startAt : a.dueAt;

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line bg-surface px-4 py-4 md:px-6">
        <Link to="/tasks" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
          <ArrowLeft className="size-3 rtl:-scale-x-100" /> {t('nav.tasks')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Icon className="size-5 shrink-0 text-muted" />
            {editable ? (
              <Input
                value={subject}
                aria-label="Subject"
                onChange={(e) => setSubject(e.target.value)}
                onBlur={() => subject.trim() && subject !== a.subject && patch.mutate({ subject })}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                className="h-auto border-transparent bg-transparent px-1 text-xl font-semibold tracking-tight hover:border-line md:text-title"
              />
            ) : (
              <h1 className="truncate text-xl font-semibold tracking-tight md:text-title">{a.subject}</h1>
            )}
            {done ? (
              <Badge tone="neutral">Done</Badge>
            ) : a.overdue ? (
              <Badge tone="accent">Overdue</Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {editable && a.type !== 'note' ? (
              <Button
                variant={done ? 'secondary' : 'primary'}
                loading={toggle.isPending}
                onClick={() => toggle.mutate(!done)}
              >
                {done ? <RotateCcw /> : <Check />} {done ? 'Reopen' : 'Complete'}
              </Button>
            ) : null}
            {can('core.activities.delete') ? (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem danger onSelect={() => remove.mutate()}>
                    <Trash2 /> Delete
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </div>
        </div>
      </header>
      <div className="grid flex-1 lg:grid-cols-[minmax(320px,400px)_1fr]">
        <aside className="border-b border-line bg-surface p-4 md:p-6 lg:border-e lg:border-b-0">
          <Row label="Type">
            <NativeSelect
              aria-label="Type"
              value={a.type}
              disabled={!editable}
              onChange={(e) => patch.mutate({ type: e.target.value })}
            >
              {Object.entries(TASK_TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </NativeSelect>
          </Row>
          <Row label={a.type === 'meeting' ? 'Starts' : 'Due'}>
            <Input
              type="datetime-local"
              aria-label={a.type === 'meeting' ? 'Starts' : 'Due'}
              disabled={!editable}
              defaultValue={toLocalInput(when)}
              key={when ?? 'none'}
              onBlur={(e) => {
                const v = fromLocalInput(e.target.value);
                if (v !== when) patch.mutate({ [whenField]: v });
              }}
            />
          </Row>
          <Row label="Priority">
            <NativeSelect
              aria-label="Priority"
              value={a.priority}
              disabled={!editable}
              onChange={(e) => patch.mutate({ priority: e.target.value })}
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </NativeSelect>
          </Row>
          <Row label="Assignee">
            <UserPicker
              aria-label="Assignee"
              value={a.assignee?.uuid ?? null}
              disabled={!editable}
              onChange={(v) => patch.mutate({ assigneeUuid: v })}
            />
          </Row>
          {a.related ? (
            <Row label="Related to">
              <RelatedValue related={a.related} />
            </Row>
          ) : null}
          <Row label="Created by">
            <span>{a.owner?.name ?? '—'}</span>
          </Row>
        </aside>
        <main className="flex min-w-0 flex-col gap-6 p-4 md:p-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold">Description</h2>
            {editable ? (
              <div className="flex flex-col gap-2">
                <RichTextEditor
                  value={body}
                  onChange={setBody}
                  aria-label="Description"
                  className="min-h-24"
                />
                {body !== (a.body ?? '') ? (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setBody(a.body ?? '')}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={patch.isPending}
                      onClick={() => patch.mutate({ body: body || null })}
                    >
                      Save
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : a.body ? (
              <div className="rte-prose text-sm" dangerouslySetInnerHTML={{ __html: a.body }} />
            ) : (
              <p className="text-sm text-muted">No description.</p>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">History</h2>
            <Timeline config={{ route: 'activities', fields: [] }} uuid={a.uuid} />
          </section>
        </main>
      </div>
    </div>
  );
}

function RelatedValue({ related }: { related: NonNullable<ActivityDto['related']> }) {
  const label = useLabel(related.type);
  return (
    <Link to={`/${ENTITY_ROUTE[related.type]}/${related.uuid}`} className="text-primary hover:underline">
      {label.singular}: {related.title}
    </Link>
  );
}
