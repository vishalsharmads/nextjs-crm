import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlarmClock, CalendarClock, CheckSquare, Flag, MoreHorizontal, Plus, X } from 'lucide-react';
import type { ActivityDto, ListResponse } from '@app/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative, fromLocalInput } from '@/lib/format';
import { useBranding } from '@/app/branding';
import { useBoot, useCan, useScope, useT } from '@/app/session';
import { useHotkeys } from '@/app/shell/hotkeys';
import { usePaletteCommands } from '@/app/shell/command-palette';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, NativeSelect } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { ACTIVITY_ICON, useToggleActivity } from './activity-components';
import { ChecklistProgress } from './task-checklist';

type Tab = 'open' | 'done';
type Who = 'mine' | 'all';
export type Group = 'overdue' | 'today' | 'upcoming' | 'none';

const GROUP_LABEL: Record<Group, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  none: 'No date',
};
const PAGE = 100;

const whenOf = (a: ActivityDto) => (a.type === 'meeting' ? a.startAt : a.dueAt);

/** Split open tasks into Overdue / Today / Upcoming / No date, in the viewer's local day. */
export function groupTasks(items: ActivityDto[], now = new Date()): [Group, ActivityDto[]][] {
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const groups: Record<Group, ActivityDto[]> = { overdue: [], today: [], upcoming: [], none: [] };
  for (const a of items) {
    const w = whenOf(a);
    if (!w) groups.none.push(a);
    else if (new Date(w) < now) groups.overdue.push(a);
    else if (new Date(w) <= endOfDay) groups.today.push(a);
    else groups.upcoming.push(a);
  }
  return (Object.keys(groups) as Group[]).filter((g) => groups[g].length).map((g) => [g, groups[g]]);
}

/** Snooze targets at 09:00 local time. */
export function snoozeTarget(kind: 'tomorrow' | 'nextWeek', now = new Date()): string {
  const d = new Date(now);
  if (kind === 'tomorrow') d.setDate(d.getDate() + 1);
  else d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); // next Monday
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function useTaskList(tab: Tab, who: Who, type: string, priority: string) {
  const conditions = [
    ...(who === 'mine' ? [{ field: 'assignee', op: 'in', value: ['@me'] }] : []),
    type
      ? { field: 'type', op: 'in', value: [type] }
      : { field: 'type', op: 'nin', value: ['note', 'email'] },
    ...(priority ? [{ field: 'priority', op: 'in', value: [priority] }] : []),
    { field: 'completed', op: 'eq', value: tab === 'done' },
  ];
  return useInfiniteQuery({
    queryKey: ['records', 'activities', 'list', 'my-work', { tab, who, type, priority }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      apiGet<ListResponse<ActivityDto>>('/activities', {
        filter: JSON.stringify({ and: conditions }),
        sort: tab === 'done' ? '-completed_at' : 'due_at',
        pageSize: PAGE,
        page: pageParam,
      }),
    getNextPageParam: (last) =>
      last.meta.page * last.meta.pageSize < last.meta.total ? last.meta.page + 1 : undefined,
  });
}

/** Reschedule one or many tasks, with an undo that restores each previous date. */
function useReschedule() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['records', 'activities'] });
  return useMutation({
    mutationFn: async ({ tasks, to }: { tasks: ActivityDto[]; to: string | null }) => {
      await Promise.all(
        tasks.map((a) =>
          apiPatch(`/activities/${a.uuid}`, { [a.type === 'meeting' ? 'startAt' : 'dueAt']: to }),
        ),
      );
      return tasks;
    },
    onSuccess: (tasks, { to }) => {
      void refresh();
      toast.success(
        tasks.length === 1
          ? `Rescheduled to ${to ? formatDateTime(to) : 'no date'}`
          : `Rescheduled ${tasks.length} tasks`,
        {
          action: {
            label: 'Undo',
            onClick: () =>
              void Promise.all(
                tasks.map((a) =>
                  apiPatch(`/activities/${a.uuid}`, {
                    [a.type === 'meeting' ? 'startAt' : 'dueAt']: whenOf(a),
                  }),
                ),
              ).then(refresh),
          },
        },
      );
    },
  });
}

function SnoozeMenu({ task, onPick }: { task: ActivityDto; onPick: (to: string | null) => void }) {
  const [picking, setPicking] = useState(false);
  if (picking)
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget).get('when') as string;
          if (v) onPick(fromLocalInput(v));
          setPicking(false);
        }}
      >
        <Input
          type="datetime-local"
          name="when"
          aria-label={`New date for ${task.subject}`}
          className="h-8 w-auto"
          autoFocus
        />
        <Button type="submit" size="sm">
          Set
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Cancel"
          onClick={() => setPicking(false)}
        >
          <X />
        </Button>
      </form>
    );
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`Reschedule ${task.subject}`}>
          <MoreHorizontal />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={() => onPick(snoozeTarget('tomorrow'))}>
          <AlarmClock /> Tomorrow, 9:00
        </MenuItem>
        <MenuItem onSelect={() => onPick(snoozeTarget('nextWeek'))}>
          <AlarmClock /> Next Monday, 9:00
        </MenuItem>
        <MenuItem onSelect={() => setPicking(true)}>
          <CalendarClock /> Pick a date…
        </MenuItem>
        {whenOf(task) ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => onPick(null)}>Remove date</MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

function TaskRow({
  a,
  selected,
  onSelect,
  active,
  showAssignee,
  editable,
  onReschedule,
}: {
  a: ActivityDto;
  selected: boolean;
  onSelect: (v: boolean) => void;
  active: boolean;
  showAssignee: boolean;
  editable: boolean;
  onReschedule: (to: string | null) => void;
}) {
  const toggle = useToggleActivity();
  const Icon = ACTIVITY_ICON[a.type];
  const done = !!a.completedAt;
  const w = whenOf(a);
  return (
    <li
      data-active={active || undefined}
      className={cn(
        'group flex items-center gap-3 px-3 py-2',
        active && 'bg-primary-soft',
        selected && 'bg-subtle',
      )}
    >
      {editable ? (
        <Checkbox checked={selected} onCheckedChange={onSelect} aria-label={`Select ${a.subject}`} />
      ) : null}
      {editable ? (
        <Checkbox
          checked={done}
          className="rounded-full"
          onCheckedChange={(v) => toggle.mutate({ uuid: a.uuid, done: v })}
          aria-label={done ? `Reopen ${a.subject}` : `Complete ${a.subject}`}
        />
      ) : null}
      <Icon className="size-4 shrink-0 text-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link
            to={`/tasks/${a.uuid}`}
            className={cn('truncate text-sm font-medium hover:underline', done && 'text-muted line-through')}
          >
            {a.subject || 'Untitled'}
          </Link>
          {a.priority === 'high' ? (
            <Badge tone="accent">
              <Flag className="size-3" /> High
            </Badge>
          ) : null}
          <ChecklistProgress checklist={a.checklist ?? { done: 0, total: 0 }} />
        </div>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted">
          {w ? (
            <span className={cn(a.overdue && 'text-accent')}>
              {a.overdue ? `Overdue · ${formatRelative(w)}` : formatDateTime(w)}
            </span>
          ) : null}
          {a.related ? <span className="truncate">· {a.related.title}</span> : null}
          {showAssignee && a.assignee ? <span>· {a.assignee.name}</span> : null}
        </p>
      </div>
      {editable && !done ? <SnoozeMenu task={a} onPick={onReschedule} /> : null}
    </li>
  );
}

/** "My work": tasks, calls and meetings, grouped by when they are due, with quick add and bulk actions. */
export function TasksPage() {
  const t = useT();
  const can = useCan();
  const { me } = useBoot();
  const scope = useScope('core.activities');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { branding } = useBranding();
  const [tab, setTab] = useState<Tab>('open');
  const [who, setWho] = useState<Who>('mine');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const [subject, setSubject] = useState('');
  const [due, setDue] = useState('');
  const addRef = useRef<HTMLInputElement>(null);
  const editable = can('core.activities.update');
  useEffect(() => setDocumentTitle(t('nav.tasks'), branding.appName), [t, branding.appName]);
  useEffect(() => {
    setSelected(new Set());
    setCursor(-1);
  }, [tab, who, type, priority]);

  const q = useTaskList(tab, who, type, priority);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const total = q.data?.pages[0]?.meta.total ?? 0;
  const groups = useMemo<[Group | 'done', ActivityDto[]][]>(
    () => (tab === 'done' ? (items.length ? [['done', items]] : []) : groupTasks(items)),
    [items, tab],
  );
  const flat = groups.flatMap(([, list]) => list);
  const reschedule = useReschedule();
  const toggle = useToggleActivity();

  const create = useMutation({
    mutationFn: () =>
      apiPost<ActivityDto>('/activities', {
        type: 'task',
        subject: subject.trim(),
        dueAt: fromLocalInput(due),
        assigneeUuid: me.uuid,
      }),
    onSuccess: (a) => {
      setSubject('');
      setDue('');
      toast.success('Task added', { action: { label: 'Open', onClick: () => navigate(`/tasks/${a.uuid}`) } });
      void qc.invalidateQueries({ queryKey: ['records', 'activities'] });
    },
  });
  const bulkComplete = useMutation({
    mutationFn: (uuids: string[]) =>
      apiPost<{ affected: number }>('/activities/bulk', {
        action: 'update_field',
        uuids,
        field: 'completed',
        value: true,
      }),
    onSuccess: (r) => {
      setSelected(new Set());
      toast.success(`Completed ${r.affected}`);
      void qc.invalidateQueries({ queryKey: ['records', 'activities'] });
    },
  });

  useHotkeys(
    {
      j: () => setCursor((c) => Math.min(flat.length - 1, c + 1)),
      k: () => setCursor((c) => Math.max(0, c - 1)),
      x: () => {
        const a = flat[cursor];
        if (a && editable) toggle.mutate({ uuid: a.uuid, done: !a.completedAt });
      },
      Enter: () => {
        const a = flat[cursor];
        if (a) navigate(`/tasks/${a.uuid}`);
      },
    },
    !!flat.length || editable,
  );
  usePaletteCommands(
    useMemo(
      () =>
        editable
          ? [
              {
                id: 'create:task',
                label: 'New task',
                group: 'Create',
                icon: Plus,
                shortcut: 'c',
                run: () => {
                  setTab('open');
                  setTimeout(() => addRef.current?.focus());
                },
              },
            ]
          : [],
      [editable],
    ),
  );
  useEffect(() => {
    if (cursor >= 0) document.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const selectedTasks = flat.filter((a) => selected.has(a.uuid));
  const select = (uuid: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(uuid);
      else n.delete(uuid);
      return n;
    });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('nav.tasks')}
        actions={
          editable ? (
            <Button variant="primary" onClick={() => addRef.current?.focus()}>
              <Plus /> New task
            </Button>
          ) : null
        }
      >
        <div role="tablist" className="flex gap-1">
          {(
            [
              ['open', 'Open'],
              ['done', 'Done'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm',
                tab === k ? 'border-primary font-medium' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-3 px-4 py-4 md:px-6">
        {editable && tab === 'open' ? (
          <form
            className="flex flex-wrap gap-2 rounded-md border border-line bg-surface p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (subject.trim()) create.mutate();
            }}
          >
            <Input
              ref={addRef}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Add a task… (press C)"
              aria-label="New task"
              className="min-w-48 flex-1"
            />
            <Input
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-label="Due"
              className="w-auto"
            />
            <Button type="submit" disabled={!subject.trim()} loading={create.isPending}>
              Add
            </Button>
          </form>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {scope !== 'own' ? (
            <NativeSelect
              aria-label="Whose tasks"
              value={who}
              onChange={(e) => setWho(e.target.value as Who)}
              className="w-auto"
            >
              <option value="mine">Assigned to me</option>
              <option value="all">{scope === 'team' ? 'My team' : 'Everyone'}</option>
            </NativeSelect>
          ) : null}
          <NativeSelect
            aria-label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-auto"
          >
            <option value="">All types</option>
            <option value="task">Tasks</option>
            <option value="call">Calls</option>
            <option value="meeting">Meetings</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-auto"
          >
            <option value="">Any priority</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </NativeSelect>
          {total ? <span className="ms-auto text-xs text-muted tabular">{total} total</span> : null}
        </div>
        {selected.size ? (
          <div
            role="toolbar"
            aria-label="Selected tasks"
            className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 shadow-raised"
          >
            <span className="text-sm font-medium">{selected.size} selected</span>
            {tab === 'open' ? (
              <>
                <Button
                  size="sm"
                  loading={bulkComplete.isPending}
                  onClick={() => bulkComplete.mutate([...selected])}
                >
                  <CheckSquare /> Complete
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    reschedule.mutate({ tasks: selectedTasks, to: snoozeTarget('tomorrow') });
                    setSelected(new Set());
                  }}
                >
                  <AlarmClock /> Tomorrow
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    reschedule.mutate({ tasks: selectedTasks, to: snoozeTarget('nextWeek') });
                    setSelected(new Set());
                  }}
                >
                  <AlarmClock /> Next week
                </Button>
              </>
            ) : null}
            <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        ) : null}
        {q.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-48" />
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !items.length ? (
          <EmptyState
            icon={<CheckSquare />}
            title={tab === 'done' ? 'Nothing completed yet' : 'You are all caught up'}
            description={
              tab === 'done'
                ? undefined
                : type || priority
                  ? 'Nothing matches these filters.'
                  : 'Add a task above, or from any record so it stays linked to it.'
            }
          />
        ) : (
          <>
            {groups.map(([g, list]) => (
              <section key={g} aria-label={g === 'done' ? 'Done' : GROUP_LABEL[g]}>
                <h2
                  className={cn(
                    'mb-1 flex items-center gap-2 text-xs font-semibold',
                    g === 'overdue' ? 'text-accent' : 'text-muted',
                  )}
                >
                  {g === 'done' ? 'Completed' : GROUP_LABEL[g]}
                  <span className="tabular font-normal">{list.length}</span>
                </h2>
                <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface">
                  {list.map((a) => (
                    <TaskRow
                      key={a.uuid}
                      a={a}
                      active={flat[cursor]?.uuid === a.uuid}
                      selected={selected.has(a.uuid)}
                      onSelect={(v) => select(a.uuid, v)}
                      showAssignee={who === 'all'}
                      editable={editable}
                      onReschedule={(to) => reschedule.mutate({ tasks: [a], to })}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {q.hasNextPage ? (
              <Button variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                Load more
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
