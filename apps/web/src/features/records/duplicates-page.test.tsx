import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const pair = {
  uuid: 'p1',
  entity: 'contact',
  rule: 'Same email',
  a: { uuid: 'a1', title: 'Ana Lee', subtitle: 'ana@example.test' },
  b: { uuid: 'b1', title: 'Ana Lee', subtitle: 'ANA@example.test' },
  createdAt: new Date().toISOString(),
};
const apiPost = vi.fn((path: string, body?: unknown) => {
  void path;
  void body;
  return Promise.resolve({});
});
vi.mock('@/lib/api', () => ({
  apiGet: () => Promise.resolve({ data: [pair] }),
  apiPost: (p: string, b?: unknown) => apiPost(p, b),
}));
vi.mock('@/app/session', () => ({
  useCan: () => () => true,
  useLabel: () => ({ singular: 'Member', plural: 'Members' }),
}));
vi.mock('@/components/ui/confirm', () => ({ confirmAction: () => Promise.resolve(true) }));

const { DuplicatesPage } = await import('./duplicates-page');

describe('merge queue', () => {
  afterEach(cleanup);

  it('merges into the record kept, or dismisses the pair', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <DuplicatesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Same email')).toBeTruthy();
    expect(screen.getByText('Member')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Keep this/ })[1]!);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/contacts/merge', { primaryUuid: 'b1', secondaryUuids: ['a1'] }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Not a duplicate/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/duplicates/pairs/p1/dismiss', undefined));
  });
});
