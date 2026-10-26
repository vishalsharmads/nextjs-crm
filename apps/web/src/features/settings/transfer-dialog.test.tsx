import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiPost = vi.fn();
vi.mock('@/app/session', () => ({ useBoot: () => ({}), useT: () => (k: string) => k, bootstrapKey: [] }));
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  apiGet: vi.fn(),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  buildUrl: (p: string) => p,
}));

const { TransferDialog } = await import('./people-pages');

const user = (uuid: string, firstName: string, status = 'active') =>
  ({ uuid, firstName, lastName: '', email: `${uuid}@example.test`, status }) as never;

describe('TransferDialog', () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiPost.mockResolvedValue({ moved: { contact: 2 } });
  });

  it('only offers other active users and posts the chosen one', async () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TransferDialog
          from={user('a', 'Leaver')}
          users={[user('a', 'Leaver'), user('b', 'Heir'), user('c', 'Invited', 'invited')]}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    const select = screen.getByLabelText(/new owner/i);
    expect(screen.queryByRole('option', { name: 'Leaver' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Invited' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Transfer' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.selectOptions(select, 'b');
    await userEvent.click(button);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/users/a/transfer-records', { toUuid: 'b' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
