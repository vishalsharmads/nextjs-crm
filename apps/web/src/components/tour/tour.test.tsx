import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiPost = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/api', () => ({ apiPost: (...a: unknown[]) => apiPost(...a) }));
vi.mock('@/app/session', () => ({
  bootstrapKey: ['boot'],
  useBoot: () => ({ labels: {}, me: { toursSeen: ['welcome'] } }),
  useCan: () => () => true,
}));
vi.mock('@/help/tours', () => ({
  TOURS: [
    {
      id: 'demo',
      title: 'Demo tour',
      route: '/here',
      steps: [
        { target: 'one', title: 'First step', body: 'First body' },
        { target: 'missing', title: 'Gone', body: 'Skipped' },
        { target: 'two', title: 'Last step', body: 'Last body' },
      ],
    },
  ],
}));

const { TourProvider, useTours } = await import('./tour');

function Page() {
  const { start } = useTours();
  return (
    <>
      <button type="button" data-tour="one" onClick={() => start('demo')}>
        Start
      </button>
      <span data-tour="two">Two</span>
    </>
  );
}

describe('guided tours', () => {
  it('walks the steps, skips missing targets and remembers the tour', async () => {
    // jsdom has no layout: give elements a box so they count as visible.
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    Element.prototype.scrollIntoView = () => undefined;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/here']}>
          <TourProvider>
            <Page />
          </TourProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('dialog', { name: 'First step' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // The missing target is skipped after a short wait.
    expect(await screen.findByRole('dialog', { name: 'Last step' }, { timeout: 5000 })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/me/tours/demo/seen'));
  });
});
