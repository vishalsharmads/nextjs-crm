import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';

let permissions: string[] = [];
vi.mock('@/app/session', () => ({
  useCan: () => (p: string) => permissions.includes(p),
  useT: () => (key: string) => i18n.t(key),
}));
vi.mock('@/lib/api', () => ({
  apiGet: () =>
    Promise.resolve({
      data: [
        {
          id: 1,
          action: 'contact.created',
          entity: 'contact',
          entityUuid: null,
          actor: { uuid: 'u', name: 'Ada' },
          actorType: 'user',
          diff: null,
          ip: null,
          createdAt: '2026-10-01T10:00:00.000Z',
        },
      ],
      meta: { total: 1, pageSize: 50 },
    }),
  apiPost: vi.fn(),
  buildUrl: (path: string) => `/api/v1${path}`,
}));

const { AuditPage } = await import('./audit-page');

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('audit page', () => {
  beforeEach(() => {
    permissions = ['core.audit.view'];
  });

  it('lists entries and offers export only with the export permission', async () => {
    renderPage();
    expect(await screen.findByText('contact.created')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Export CSV/ })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Access' })).toBeInTheDocument();
  });

  it('links the export to the current tab', async () => {
    permissions = ['core.audit.view', 'core.audit.export'];
    renderPage();
    expect(await screen.findByRole('link', { name: /Export CSV/ })).toHaveAttribute(
      'href',
      '/api/v1/audit-logs/export',
    );
  });
});
