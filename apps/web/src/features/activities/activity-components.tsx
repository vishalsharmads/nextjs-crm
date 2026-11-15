import { useState } from 'react';
import { Link } from 'react-router';
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
  Repeat,
} from 'lucide-react';
import {
  ENTITY_ROUTE,
  describeRecurrence,
  type ActivityDto,
  type ActivityType,
  type RelatedType,
} from '@app/shared';
import { apiGet, apiPost } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative, fromLocalInput, toLocalInput } from '@/lib/format';
import { useBoot, useCan, useLabel } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { useSavedReplies } from '@/components/editor/use-templates';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { UserPicker } from '@/components/fields/pickers';
import { ChecklistProgress } from './task-checklist';
import { ParticipantsPicker, type PickedParticipant } from './participants-picker';
import { ComposeEmail } from '@/features/email/compose-email';

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

/** "· Membership: Mei – hot desk", linking to the record the activity was logged on. */
function RelatedLink({ related }: { related: NonNullable<ActivityDto['related']> }) {
  const label = useLabel(related.type);
  return (
    <span className="truncate text-xs text-muted">
      · {label.singular}:{' '}
      <Link to={`/${ENTITY_ROUTE[related.type]}/${related.uuid}`} className="text-ink hover:underline">
        {related.title}
      </Link>
    </span>
  );
}

export function ActivityItem({
  a,
  showRelated,
  record,
}: {
  a: ActivityDto;
  showRelated?: boolean;
  /** The record whose timeline shows this item: needed to open an email conversation. */
  record?: { type: RelatedType; uuid: string };
}) {
  const [threadOpen, setThreadOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const replyTo =
    a.type === 'email' && record
      ? (a.participants.find((p) => p.role === 'from' && p.kind !== 'user') ??
        a.participants.find((p) => p.kind !== 'user'))
      : undefined;
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
            <Link
              to={`/tasks/${a.uuid}`}
              className={cn('text-sm font-medium hover:underline', done && 'text-muted line-through')}
            >
              {a.subject || TYPE_LABEL[a.type]}
            </Link>
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
          {a.recurrence ? (
            <span className="text-muted" title={describeRecurrence(a.recurrence)}>
              <Repeat className="size-3" aria-label={describeRecurrence(a.recurrence)} />
            </span>
          ) : null}
          {a.checklist?.total ? <ChecklistProgress checklist={a.checklist} /> : null}
          {showRelated && a.related ? <RelatedLink related={a.related} /> : null}
        </div>
        {a.body ? (
          <div className="rte-prose mt-1 text-sm text-ink" dangerouslySetInnerHTML={{ __html: a.body }} />
        ) : null}
        <p className="mt-0.5 text-xs text-faint">
          {TYPE_LABEL[a.type]}
          {a.assignee ? ` · ${a.assignee.name}` : ''}
          {a.type === 'note' ? ` · ${formatRelative(a.createdAt)}` : ''}
          {a.participants?.length ? ` · with ${a.participants.map((p) => p.name).join(', ')}` : ''}
        </p>
        {a.type === 'email' && record && can('core.email.use') ? (
          <button
            type="button"
            className="me-3 text-xs text-primary hover:underline"
            onClick={() => setReplying(true)}
          >
            Reply
          </button>
        ) : null}
        {replying && record ? (
          <ComposeEmail
            to={replyTo?.email ?? ''}
            related={record}
            reply={{ activityUuid: a.uuid, subject: a.subject }}
            onClose={() => setReplying(false)}
          />
        ) : null}
        {a.thread && a.thread.count > 1 && record ? (
          <div className="mt-1">
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              aria-expanded={threadOpen}
              onClick={() => setThreadOpen(!threadOpen)}
            >
              {threadOpen ? 'Hide conversation' : `${a.thread.count} messages in this conversation`}
            </button>
            {threadOpen ? <EmailThread threadId={a.thread.id} record={record} /> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

interface ThreadMessage extends ActivityDto {
  message: { direction: 'inbound' | 'outbound'; from: string; to: string[]; sentAt: string };
}

/** Every message of an email conversation that is on this record, oldest first. */
function EmailThread({
  threadId,
  record,
}: {
  threadId: string;
  record: { type: RelatedType; uuid: string };
}) {
  const q = useQuery({
    queryKey: ['email-thread', threadId, record.uuid],
    queryFn: () =>
      apiGet<{ data: ThreadMessage[] }>(`/email/threads/${threadId}`, {
        type: record.type,
        uuid: record.uuid,
      }).then((r) => r.data),
  });
  if (q.isPending) return <Skeleton className="mt-2 h-16" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <ol className="mt-2 flex flex-col gap-2 border-s-2 border-line ps-3">
      {q.data.map((m) => (
        <li key={m.uuid} className="text-sm">
          <p className="text-xs text-muted">
            {m.message.direction === 'inbound' ? m.message.from : `To ${m.message.to.join(', ')}`} ·{' '}
            {formatDateTime(m.message.sentAt)}
          </p>
          <p className="font-medium">{m.subject}</p>
          {m.body ? <div className="rte-prose text-sm" dangerouslySetInnerHTML={{ __html: m.body }} /> : null}
        </li>
      ))}
    </ol>
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
  const [participants, setParticipants] = useState<PickedParticipant[]>([]);
  const reset = () => {
    setSubject('');
    setBody('');
    setWhen('');
    setParticipants([]);
  };
  const replies = useSavedReplies(related);
  const create = useMutation({
    mutationFn: () =>
      apiPost<ActivityDto>('/activities', {
        type,
        subject,
        body: body || null,
        dueAt: type === 'task' || type === 'call' ? fromLocalInput(when) : null,
        startAt: type === 'meeting' ? fromLocalInput(when) : null,
        endAt:
          type === 'meeting' && when ? new Date(new Date(when).getTime() + 3600_000).toISOString() : null,
        assigneeUuid: assignee,
        related,
        completed: type === 'call' && !when ? true : undefined,
        ...(type === 'meeting' || type === 'call'
          ? { participants: participants.map(({ kind, uuid }) => ({ kind, uuid })) }
          : {}),
      }),
    onSuccess: () => {
      reset();
      toast.success(type === 'note' ? 'Note added' : `${TYPE_LABEL[type]} added`);
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['records'] });
      onCreated?.();
    },
  });
  const valid = type === 'note' ? !!body : !!subject.trim();
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
        <RichTextEditor
          value={body}
          onChange={setBody}
          placeholder={type === 'note' ? 'Write a note… Type / for a saved reply.' : 'Details (optional)'}
          aria-label="Details"
          replies={replies}
          className="min-h-16"
          onSubmitShortcut={() => {
            if (valid) create.mutate();
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
        {type === 'meeting' || type === 'call' ? (
          <ParticipantsPicker value={participants} onChange={setParticipants} />
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
