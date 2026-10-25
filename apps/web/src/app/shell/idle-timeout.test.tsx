import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';

const logout = vi.fn(() => Promise.resolve());
vi.mock('@/lib/api', () => ({ apiPost: () => logout() }));
vi.mock('@/app/session', () => ({
  bootstrapKey: ['bootstrap'],
  useBoot: () => ({ settings: { session: { idleTimeoutMinutes: 2, profile: 'hipaa' } } }),
  useT: () => (key: string, vars?: Record<string, unknown>) => i18n.t(key, vars),
}));

const { IdleTimeout } = await import('./idle-timeout');

function renderTimer() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<IdleTimeout />} />
          <Route path="/login" element={<p>Sign-in page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('idle sign-out', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    localStorage.clear();
    fireEvent.keyDown(window);
    logout.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('warns a minute before the limit and input dismisses the warning', () => {
    renderTimer();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => vi.advanceTimersByTime(65_000));
    expect(screen.getByRole('dialog')).toHaveTextContent('Are you still there?');
    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });

  it('signs out when the limit passes without input', async () => {
    renderTimer();
    await act(async () => {
      vi.advanceTimersByTime(121_000);
    });
    expect(logout).toHaveBeenCalledTimes(1);
    // findBy* polls with timers, so let real time run for the navigation.
    vi.useRealTimers();
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });
});
