import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskComments } from './task-comments';

const canUpdate = { value: true };
vi.mock('@/app/session', () => ({
  useBoot: () => ({ me: { uuid: 'me' } }),
  useCan: () => () => canUpdate.value,
}));
vi.mock('@/features/records/api', () => ({ useUsersPicker: () => ({ data: [], isFetching: false }) }));
vi.mock('@/components/editor/rich-text-editor', () => ({
  RichTextEditor: (p: { 'aria-label': string }) => <textarea aria-label={p['aria-label']} />,
}));
vi.mock('@/lib/api', () => ({
  apiGet: () =>
    Promise.resolve({
      data: [
        {
          uuid: 'c1',
          body: '<p>Looks good</p>',
          author: { uuid: 'u1', name: 'Ana Ruiz' },
          mentions: [{ uuid: 'me', name: 'Sam Lee' }],
          createdAt: '2026-11-01T10:00:00.000Z',
          editedAt: null,
          canEdit: false,
        },
      ],
    }),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskComments taskUuid="t1" />
    </QueryClientProvider>,
  );
}

describe('task comments', () => {
  afterEach(cleanup);

  it('lists comments with mentions and hides edit controls on others’ comments', async () => {
    show();
    expect(await screen.findByText('Looks good')).toBeInTheDocument();
    expect(screen.getByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.getByText(/Sam Lee/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit comment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
  });

  it('shows no composer without permission to update tasks', async () => {
    canUpdate.value = false;
    show();
    await screen.findByText('Looks good');
    expect(screen.queryByLabelText('Comment')).toBeNull();
  });
});
