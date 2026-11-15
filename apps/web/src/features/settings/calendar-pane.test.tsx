import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiPost = vi.fn((path: string, body?: unknown) => {
  void body;
  return Promise.resolve(
    path === '/me/calendar-feed' ? { url: 'https://crm.example.test/api/v1/public/calendar/x.ics' } : {},
  );
});
vi.mock('@/lib/api', () => ({
  apiGet: (path: string) => Promise.resolve(path === '/me/calendar-feed' ? { active: false } : { data: [] }),
  apiPost: (p: string, b?: unknown) => apiPost(p, b),
  apiDelete: () => Promise.resolve(),
}));

const { CalendarPane } = await import('./calendar-pane');

describe('calendar pane', () => {
  afterEach(cleanup);

  it('connects a calendar and creates a feed address', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CalendarPane />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Calendar address (CalDAV)'), {
      target: { value: 'https://dav.example.test/cal/' },
    });
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'me' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/calendar/accounts', {
        url: 'https://dav.example.test/cal/',
        username: 'me',
        password: 'pw',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create address' }));
    expect(
      await screen.findByDisplayValue('https://crm.example.test/api/v1/public/calendar/x.ics'),
    ).toBeInTheDocument();
  });
});
