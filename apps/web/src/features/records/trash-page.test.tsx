import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let permissions: string[] = [];
let rows: { uuid: string; name: string; deletedAt: string }[] = [];
const apiPost = vi.fn();

vi.mock('@/app/session', () => ({
  useBoot: () => ({
    settings: { features: { leads: true } },
    labels: {
      contact: { singular: 'Member', plural: 'Members' },
      organization: { singular: 'Company', plural: 'Companies' },
      lead: { singular: 'Enquiry', plural: 'Enquiries' },
      deal: { singular: 'Deal', plural: 'Deals' },
    },
  }),
  useCan: () => (p: string) => permissions.includes(p),
}));
vi.mock('@/app/branding', () => ({ useBranding: () => ({ branding: { appName: 'Test' } }) }));
vi.mock('./entities', () => ({
  useEntityConfig: (entity: string) => ({
    entity,
    route: `${entity}s`,
    resource: `core.${entity}s`,
    singular: entity === 'contact' ? 'Member' : entity,
    plural: entity === 'contact' ? 'Members' : `${entity}s`,
    title: (r: { name: string }) => r.name,
  }),
}));
vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(() => Promise.resolve({ data: rows, meta: { page: 1, pageSize: 50, total: rows.length } })),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  api: vi.fn(),
  buildUrl: (p: string) => p,
}));

const { TrashPage } = await import('./trash-page');

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TrashPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TrashPage', () => {
  beforeEach(() => {
    permissions = ['core.contacts.delete'];
    rows = [];
    apiPost.mockReset();
    apiPost.mockResolvedValue({ uuid: 'a' });
  });

  it('shows only entities the user may delete, with vocabulary labels', async () => {
    renderPage();
    expect(await screen.findByRole('tab', { name: 'Members' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Companies' })).toBeNull();
  });

  it('explains when the user has no delete permission', async () => {
    permissions = [];
    renderPage();
    expect(await screen.findByText('Nothing to show')).toBeTruthy();
  });

  it('shows an empty state when nothing is deleted', async () => {
    renderPage();
    expect(await screen.findByText('No deleted members')).toBeTruthy();
  });

  it('restores a record', async () => {
    rows = [{ uuid: 'a', name: 'Ada Lovelace', deletedAt: '2026-10-01T10:00:00.000Z' }];
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /restore/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/contacts/a/restore'));
  });
});
