import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ActivityDto } from '@app/shared';
import type * as Misc from '@/components/ui/misc';
import { TasksPage, groupTasks, snoozeTarget } from './tasks-page';

const task = (uuid: string, dueAt: string | null, extra: Partial<ActivityDto> = {}) =>
  ({
    uuid,
    type: 'task',
    subject: `Task ${uuid}`,
    dueAt,
    startAt: null,
    completedAt: null,
    priority: 'normal',
    overdue: false,
    assignee: null,
    related: null,
    checklist: { done: 0, total: 0 },
    recurrence: null,
    ...extra,
  }) as unknown as ActivityDto;

describe('groupTasks', () => {
  it('splits open tasks into overdue, today, upcoming and no date', () => {
    const now = new Date(2026, 10, 13, 12, 0);
    const groups = groupTasks(
      [
        task('a', new Date(2026, 10, 12, 9).toISOString()),
        task('b', new Date(2026, 10, 13, 15).toISOString()),
        task('c', new Date(2026, 10, 20, 9).toISOString()),
        task('d', null),
      ],
      now,
    );
    expect(groups.map(([g, l]) => [g, l.map((t) => t.uuid)])).toEqual([
      ['overdue', ['a']],
      ['today', ['b']],
      ['upcoming', ['c']],
      ['none', ['d']],
    ]);
  });

  it('snoozes to 9:00 tomorrow and next Monday', () => {
    const friday = new Date(2026, 10, 13, 16, 30); // Friday
    const tomorrow = new Date(snoozeTarget('tomorrow', friday));
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([14, 9]);
    const monday = new Date(snoozeTarget('nextWeek', friday));
    expect([monday.getDay(), monday.getDate(), monday.getHours()]).toEqual([1, 16, 9]);
  });
});

const features = { taskPipeline: false };
vi.mock('@/app/session', () => ({
  useBoot: () => ({ me: { uuid: 'me' }, settings: { features } }),
  useCan: () => () => true,
  useScope: () => 'team',
  useT: () => (k: string) => (k === 'nav.tasks' ? 'My work' : k),
}));
vi.mock('@/app/branding', () => ({ useBranding: () => ({ branding: { appName: 'CRM' } }) }));
vi.mock('@/features/pipelines/pipeline-board', () => ({
  PipelineBoard: () => <div>Status board</div>,
}));
vi.mock('@/app/shell/command-palette', () => ({ usePaletteCommands: () => undefined }));
vi.mock('@/components/ui/misc', async (orig) => ({
  ...(await orig<typeof Misc>()),
  PageHeader: ({ title, actions, children }: { title: string; actions: unknown; children: unknown }) => (
    <div>
      <h1>{title}</h1>
      {actions as never}
      {children as never}
    </div>
  ),
}));
vi.mock('@/lib/api', () => ({
  apiGet: () =>
    Promise.resolve({
      data: [
        task('late', '2020-01-01T09:00:00.000Z', { overdue: true, priority: 'high' }),
        task('later', '2099-01-01T09:00:00.000Z', { checklist: { done: 1, total: 3 } }),
      ],
      meta: { page: 1, pageSize: 100, total: 2 },
    }),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

describe('my work page', () => {
  afterEach(cleanup);

  it('groups tasks, offers quick add, filters and a team switch', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TasksPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const overdue = await screen.findByRole('region', { name: 'Overdue' });
    expect(within(overdue).getByRole('link', { name: 'Task late' })).toHaveAttribute('href', '/tasks/late');
    expect(
      within(screen.getByRole('region', { name: 'Upcoming' })).getByLabelText('Checklist 1 of 3 done'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('New task')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Whose tasks' })).toHaveTextContent('My team');
    expect(screen.getByRole('button', { name: 'Reschedule Task late' })).toBeInTheDocument();
  });

  it('switches to a status board when task statuses are on', async () => {
    features.taskPipeline = true;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TasksPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('region', { name: 'Overdue' });
    screen.getByRole('button', { name: 'Board' }).click();
    expect(await screen.findByText('Status board')).toBeInTheDocument();
    features.taskPipeline = false;
  });
});
