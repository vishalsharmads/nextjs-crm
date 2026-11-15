import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ActivityDto } from '@app/shared';
import { ActivityItem } from './activity-components';

vi.mock('@/app/session', () => ({
  useBoot: () => ({ me: { uuid: 'me' } }),
  useCan: () => () => false,
  useLabel: (entity: string) =>
    entity === 'deal'
      ? { singular: 'Membership', plural: 'Memberships' }
      : { singular: entity, plural: entity },
}));

const note = {
  uuid: 'a1',
  type: 'note',
  subject: '',
  body: '<p>Called about the hot desk</p>',
  dueAt: null,
  startAt: null,
  endAt: null,
  completedAt: '2026-10-25T10:00:00.000Z',
  createdAt: '2026-10-25T10:00:00.000Z',
  priority: 'normal',
  overdue: false,
  assignee: null,
  owner: null,
  related: { type: 'deal', uuid: 'd1', title: 'Mei – hot desk' },
} as unknown as ActivityDto;

function show(showRelated: boolean) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ul>
          <ActivityItem a={note} showRelated={showRelated} />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('activity item', () => {
  afterEach(cleanup);

  it('links to the record a rolled-up note was logged on, in the workspace vocabulary', () => {
    show(true);
    expect(screen.getByText(/Membership:/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mei – hot desk' })).toHaveAttribute('href', '/deals/d1');
  });

  it('shows no link for a note logged on the record itself', () => {
    show(false);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('names the participants and opens an email conversation', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const email = {
      ...note,
      uuid: 'e1',
      type: 'email',
      subject: 'Quote',
      participants: [
        { kind: 'contact', uuid: 'c1', name: 'Ann Lee', role: 'to' },
        { kind: 'user', uuid: 'u1', name: 'Sam Rep', role: 'cc' },
      ],
      thread: { id: 't1', count: 3 },
    } as unknown as ActivityDto;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ul>
            <ActivityItem a={email} record={{ type: 'contact', uuid: 'c1' }} />
          </ul>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/with Ann Lee, Sam Rep/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '3 messages in this conversation' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Hide conversation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
