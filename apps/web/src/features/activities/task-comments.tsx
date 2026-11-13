import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AtSign, MessageSquare, Pencil, Trash2, X } from 'lucide-react';
import type { ActivityCommentDto } from '@app/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Avatar, EmptyState, Skeleton } from '@/components/ui/misc';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { Combobox } from '@/components/fields/combobox';
import { useUsersPicker } from '@/features/records/api';

const commentsKey = (uuid: string) => ['records', 'activities', 'comments', uuid] as const;

type Person = { uuid: string; name: string };

/** Pick people to notify; they must be able to see the task, which the server checks. */
function MentionPicker({ value, onChange }: { value: Person[]; onChange: (v: Person[]) => void }) {
  const [q, setQ] = useState('');
  const { me } = useBoot();
  const users = useUsersPicker(q);
  const options = useMemo(
    () =>
      (users.data ?? [])
        .filter((u) => u.uuid !== me.uuid && !value.some((v) => v.uuid === u.uuid))
        .map((u) => ({ value: u.uuid, label: `${u.firstName} ${u.lastName}`.trim() || u.email })),
    [users.data, me.uuid, value],
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((p) => (
        <span
          key={p.uuid}
          className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs"
        >
          @{p.name}
          <button
            type="button"
            aria-label={`Remove ${p.name}`}
            onClick={() => onChange(value.filter((v) => v.uuid !== p.uuid))}
            className="text-muted hover:text-ink"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <div className="w-48">
        <Combobox
          aria-label="Mention someone"
          value={null}
          options={options}
          onSearch={setQ}
          loading={users.isFetching}
          placeholder="Mention someone"
          onChange={(v) => {
            const o = options.find((x) => x.value === v);
            if (o) onChange([...value, { uuid: o.value, name: o.label }]);
          }}
        />
      </div>
    </div>
  );
}

function CommentItem({ c, taskUuid }: { c: ActivityCommentDto; taskUuid: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const refresh = () => qc.invalidateQueries({ queryKey: commentsKey(taskUuid) });
  const save = useMutation({
    mutationFn: () => apiPatch(`/activities/comments/${c.uuid}`, { body }),
    onSuccess: () => {
      setEditing(false);
      toast.success('Saved');
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/activities/comments/${c.uuid}`),
    onSuccess: () => {
      toast.success('Deleted');
      void refresh();
    },
  });
  const name = c.author?.name ?? 'Former user';
  return (
    <li className="flex gap-3 py-3">
      <Avatar name={name} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{name}</span>
          <time className="text-xs text-faint" dateTime={c.createdAt} title={formatDateTime(c.createdAt)}>
            {formatRelative(c.createdAt)}
            {c.editedAt ? ' · edited' : ''}
          </time>
        </p>
        {editing ? (
          <div className="mt-1 flex flex-col gap-2">
            <RichTextEditor value={body} onChange={setBody} aria-label="Edit comment" className="min-h-16" />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="rte-prose mt-0.5 text-sm" dangerouslySetInnerHTML={{ __html: c.body }} />
        )}
        {c.mentions.length ? (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted">
            <AtSign className="size-3" /> {c.mentions.map((m) => m.name).join(', ')}
          </p>
        ) : null}
      </div>
      {c.canEdit && !editing ? (
        <div className="flex shrink-0 gap-1">
          <Button size="icon" variant="ghost" aria-label="Edit comment" onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Delete comment" onClick={() => remove.mutate()}>
            <Trash2 />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** The discussion on one task: comments with mentions. */
export function TaskComments({ taskUuid }: { taskUuid: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<Person[]>([]);
  const q = useQuery({
    queryKey: commentsKey(taskUuid),
    queryFn: () =>
      apiGet<{ data: ActivityCommentDto[] }>(`/activities/${taskUuid}/comments`).then((r) => r.data),
  });
  const post = useMutation({
    mutationFn: () =>
      apiPost<ActivityCommentDto>(`/activities/${taskUuid}/comments`, {
        body,
        mentions: mentions.map((m) => m.uuid),
      }),
    onSuccess: () => {
      setBody('');
      setMentions([]);
      toast.success('Comment added');
      void qc.invalidateQueries({ queryKey: commentsKey(taskUuid) });
    },
  });
  const empty = !body.replace(/<[^>]*>/g, '').trim();
  return (
    <div>
      {q.isPending ? (
        <Skeleton className="h-20" />
      ) : q.data?.length ? (
        <ul className="divide-y divide-line">
          {q.data.map((c) => (
            <CommentItem key={c.uuid} c={c} taskUuid={taskUuid} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<MessageSquare />}
          title="No comments yet"
          description="Ask a question or share an update. Mention someone to notify them."
        />
      )}
      {can('core.activities.update') ? (
        <form
          className="mt-3 flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!empty) post.mutate();
          }}
        >
          <RichTextEditor
            value={body}
            onChange={setBody}
            placeholder="Write a comment…"
            aria-label="Comment"
            className="min-h-16"
            onSubmitShortcut={() => !empty && post.mutate()}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MentionPicker value={mentions} onChange={setMentions} />
            <Button type="submit" size="sm" variant="primary" disabled={empty} loading={post.isPending}>
              Comment
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
