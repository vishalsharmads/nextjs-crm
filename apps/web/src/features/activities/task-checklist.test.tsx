import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChecklistProgress, TaskChecklist } from './task-checklist';

vi.mock('@/lib/api', () => ({
  apiGet: () =>
    Promise.resolve({
      data: [
        { uuid: 'i1', label: 'Send welcome pack', done: true, doneAt: null, doneBy: null },
        { uuid: 'i2', label: 'Book induction', done: false, doneAt: null, doneBy: null },
      ],
    }),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

const show = (editable: boolean) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskChecklist taskUuid="t1" editable={editable} />
    </QueryClientProvider>,
  );

describe('task checklist', () => {
  afterEach(cleanup);

  it('shows progress and lets editors add items', async () => {
    show(true);
    expect(await screen.findByRole('progressbar', { name: 'Checklist progress' })).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
    expect(screen.getByRole('checkbox', { name: 'Untick Send welcome pack' })).toBeChecked();
    expect(screen.getByLabelText('New checklist item')).toBeInTheDocument();
  });

  it('is read-only without permission', async () => {
    show(false);
    expect(await screen.findByText('Book induction')).toBeInTheDocument();
    expect(screen.queryByLabelText('New checklist item')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Tick Book induction' })).toBeDisabled();
  });

  it('labels the progress chip and hides it for tasks without a checklist', () => {
    render(<ChecklistProgress checklist={{ done: 2, total: 5 }} />);
    expect(screen.getByLabelText('Checklist 2 of 5 done')).toBeInTheDocument();
    cleanup();
    const { container } = render(<ChecklistProgress checklist={{ done: 0, total: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
