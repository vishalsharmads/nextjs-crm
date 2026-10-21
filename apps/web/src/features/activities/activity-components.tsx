import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CalendarClock,
  CheckSquare,
  MessageSquare,
  Phone,
  StickyNote,
  Users,
  Mail,
  Flag,
} from 'lucide-react';
import type { ActivityDto, ActivityType, RelatedType } from '@app/shared';
import { apiGet, apiPost } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative, fromLocalInput, toLocalInput } from '@/lib/format';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge, EmptyState, Skeleton } from '@/components/ui/misc';
import { UserPicker } from '@/components/fields/pickers';

export const ACTIVITY_ICON: Record<ActivityType, typeof StickyNote> = {
  note: StickyNote,
  task: CheckSquare,
  call: Phone,
  meeting: Users,
  email: Mail,
};
const TYPE_LABEL: Record<ActivityType, string> = {
  note: 'Note',
  task: 'Task',
  call: 'Call',
  meeting: 'Meeting',
  email: 'Email',
};

/** Toggle completion optimistically across every cached list that contains the activity. */
export function useToggleActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, done }: { uuid: string; done: boolean }) =>
      apiPost<ActivityDto>(`/activities/${uuid}/${done ? 'complete' : 'reopen'}`),
    onMutate: async ({ uuid, done }) => {
      const patch = (a: ActivityDto) =>
        a.uuid === uuid
          ? { ...a, completedAt: done ? new Date().toISOString() : null, overdue: done ? false : a.overdue }
          : a;
      const snapshots = qc.getQueriesData<{ data: ActivityDto[] }>({ queryKey: ['activities'] });
      for (const [key, value] of snapshots)
        if (value?.data) qc.setQueryData(key, { ...value, data: value.data.map(patch) });
      const lists = qc.getQueriesData<{ data: ActivityDto[]; meta: unknown }>({
        queryKey: ['records', 'activities', 'list'],
      });
      for (const [key, value] of lists)
        if (value?.data) qc.setQueryData(key, { ...value, data: value.data.map(patch) });
      return { snapshots, lists };
    },
    onError: (_e, _v, ctx) => {
      for (const [key, value] of [...(ctx?.snapshots ?? []), ...(ctx?.lists ?? [])])
        qc.setQueryData(key, value);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['records', 'activities'] });
    },
    onSuccess: (a, v) => {
      if (v.done)
        toast.success(`Completed “${a.subject}”`, {
          action: {
            label: 'Undo',
            onClick: () =>
              void apiPost(`/activities/${a.uuid}/reopen`).then(() =>
                qc.invalidateQueries({ queryKey: ['activities'] }),
              ),
          },
        });
    },
  });
}

export function ActivityItem({ a, showRelated }: { a: ActivityDto; showRelated?: boolean }) {
  const toggle = useToggleActivity();
  const can = useCan();
  const Icon = ACTIVITY_ICON[a.type];
  const done = !!a.completedAt;
  const checkable = a.type !== 'note' && can('core.activities.update');
  const when = a.type === 'meeting' ? a.startAt : a.dueAt;
  return (
    <li className="flex gap-3 py-2.5">
      <div className="pt-0.5">
        {checkable ? (
          <Checkbox
            checked={done}
            onCheckedChange={(v) => toggle.mutate({ uuid: a.uuid, done: v })}
            aria-label={done ? `Reopen ${a.subject}` : `Complete ${a.subject}`}
          />
        ) : (
          <Icon className="size-4 text-muted" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {a.type !== 'note' ? (
            <span className={cn('text-sm font-medium', done && 'text-muted line-through')}>
              {a.subject || TYPE_LABEL[a.type]}
            </span>
          ) : null}
          {when ? (
            <span className={cn('flex items-center gap-1 text-xs', a.overdue ? 'text-accent' : 'text-muted')}>
              <CalendarClock className="size-3" />{' '}
              {a.overdue ? `Overdue · ${formatRelative(when)}` : formatDateTime(when)}
            </span>
          ) : null}
          {a.priority === 'high' ? (
            <Badge tone="accent">
              <Flag className="size-3" /> High
            </Badge>
          ) : null}
          {showRelated && a.related ? (
            <span className="truncate text-xs text-muted">· {a.related.title}</span>
          ) : null}
        </div>
        {a.body ? (
          <div
            className="prose-sm mt-1 text-sm text-ink [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:ps-5"
            dangerouslySetInnerHTML={{ __html: a.body }}
          />
        ) : null}
        <p className="mt-0.5 text-xs text-faint">
          {TYPE_LABEL[a.type]}
          {a.assignee ? ` · ${a.assignee.name}` : ''}
          {a.type === 'note' ? ` · ${formatRelative(a.createdAt)}` : ''}
        </p>
      </div>
    </li>
  );
}

/** One composer for notes, tasks, calls and meetings on a record. */
export function ActivityComposer({
  related,
  onCreated,
}: {
  related: { type: RelatedType; uuid: string };
  onCreated?: () => void;
}) {
  const { me } = useBoot();
  const qc = useQueryClient();
  const [type, setType] = useState<ActivityType>('note');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [when, setWhen] = useState('');
  const [assignee, setAssignee] = useState<string | null>(me.uuid);
  const reset = () => {
    setSubject('');
    setBody('');
    setWhen('');
  };
  const create = useMutation({
    mutationFn: () =>
      apiPost<ActivityDto>('/activities', {
        type,
        subject,
        body: body
          ? `<p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`
          : null,
        dueAt: type === 'task' || type === 'call' ? fromLocalInput(when) : null,
        startAt: type === 'meeting' ? fromLocalInput(when) : null,
        endAt:
          type === 'meeting' && when ? new Date(new Date(when).getTime() + 3600_000).toISOString() : null,
        assigneeUuid: assignee,
        related,
        completed: type === 'call' && !when ? true : undefined,
      }),
    onSuccess: () => {
      reset();
      toast.success(type === 'note' ? 'Note added' : `${TYPE_LABEL[type]} added`);
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['records'] });
      onCreated?.();
    },
  });
  const valid = type === 'note' ? !!body.trim() : !!subject.trim();
  return (
    <div className="rounded-md border border-line bg-surface">
      <div role="tablist" aria-label="Activity type" className="flex gap-1 border-b border-line px-2 pt-1.5">
        {(['note', 'task', 'call', 'meeting'] as const).map((t) => {
          const Icon = ACTIVITY_ICON[t];
          return (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={type === t}
              onClick={() => setType(t)}
              className={cn(
                '-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs',
                type === t
                  ? 'border-primary font-medium text-ink'
                  : 'border-transparent text-muted hover:text-ink',
              )}
            >
              <Icon className="size-3.5" /> {TYPE_LABEL[t]}
            </button>
          );
        })}
      </div>
      <form
        className="flex flex-col gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
      >
        {type !== 'note' ? (
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={
              type === 'call'
                ? 'What was the call about?'
                : type === 'meeting'
                  ? 'Meeting title'
                  : 'What needs doing?'
            }
            aria-label="Subject"
          />
        ) : null}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={type === 'note' ? 'Write a note…' : 'Details (optional)'}
          aria-label="Details"
          className="min-h-16"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && valid) create.mutate();
          }}
        />
        {type !== 'note' ? (
          <div className="flex flex-wrap gap-2">
            <Input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              aria-label={type === 'meeting' ? 'Starts' : 'Due'}
              className="w-auto"
            />
            <div className="min-w-44 flex-1">
              <UserPicker value={assignee} onChange={setAssignee} placeholder="Assignee" />
            </div>
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" variant="primary" disabled={!valid} loading={create.isPending}>
            {type === 'note' ? 'Add note' : `Add ${TYPE_LABEL[type].toLowerCase()}`}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function RecordActivities({ type, uuid }: { type: RelatedType; uuid: string }) {
  const q = useQuery({
    queryKey: qk.activitiesFor(type, uuid),
    queryFn: () =>
      apiGet<{ data: ActivityDto[] }>('/activities/for', { type, uuid, status: 'all' }).then((r) => r.data),
  });
  if (q.isPending) return <Skeleton className="h-24" />;
  const open = (q.data ?? []).filter((a) => !a.completedAt && a.type !== 'note');
  const done = (q.data ?? []).filter((a) => a.completedAt && a.type !== 'note');
  if (!open.length && !done.length)
    return (
      <EmptyState
        icon={<MessageSquare />}
        title="No tasks or meetings yet"
        description="Plan the next step with the composer above."
      />
    );
  return (
    <div className="flex flex-col gap-4">
      {open.length ? (
        <section>
          <h3 className="text-xs font-semibold text-muted">Up next</h3>
          <ul className="divide-y divide-line">
            {open.map((a) => (
              <ActivityItem key={a.uuid} a={a} />
            ))}
          </ul>
        </section>
      ) : null}
      {done.length ? (
        <section>
          <h3 className="text-xs font-semibold text-muted">Done</h3>
          <ul className="divide-y divide-line">
            {done.map((a) => (
              <ActivityItem key={a.uuid} a={a} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Next open activity, for the peek sheet. */
export function useNextActivity(type: RelatedType, uuid: string) {
  const q = useQuery({
    queryKey: [...qk.activitiesFor(type, uuid), 'open'],
    queryFn: () =>
      apiGet<{ data: ActivityDto[] }>('/activities/for', { type, uuid, status: 'open' }).then((r) => r.data),
  });
  return q.data?.filter((a) => a.type !== 'note')[0] ?? null;
}

export { toLocalInput };
