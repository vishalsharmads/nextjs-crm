import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiDelete = vi.fn((path: string) => Promise.resolve(path));
vi.mock('@/lib/api', () => ({
  apiGet: (path: string) =>
    Promise.resolve(
      path === '/teams'
        ? { data: [] }
        : {
            canManage: false,
            data: [
              {
                uuid: 's1',
                user: { uuid: 'me', name: 'Me Myself' },
                team: null,
                level: 'view',
                sharedBy: null,
                createdAt: new Date().toISOString(),
              },
              {
                uuid: 's2',
                user: { uuid: 'u2', name: 'Other Person' },
                team: null,
                level: 'edit',
                sharedBy: null,
                createdAt: new Date().toISOString(),
              },
            ],
          },
    ),
  apiPost: () => Promise.resolve(),
  apiDelete: (p: string) => apiDelete(p),
}));
vi.mock('@/app/session', () => ({ useBoot: () => ({ me: { uuid: 'me' } }) }));
vi.mock('./api', () => ({ useUsersPicker: () => ({ data: [], isFetching: false }) }));

const { ShareDialog } = await import('./share-dialog');

describe('share dialog', () => {
  afterEach(cleanup);

  it('lets someone without sharing rights see the list and remove only their own access', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ShareDialog route="deals" uuid="d1" title="Harbour" onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Other Person')).toBeTruthy();
    expect(screen.getByText('Only the owner or an admin can share this record.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop sharing with Other Person' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Me Myself' }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/deals/d1/shares/s1'));
  });
});
