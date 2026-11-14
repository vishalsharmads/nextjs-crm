import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';

const apiGet = vi.fn((path: string) => {
  void path;
  return Promise.resolve({
    data: [
      // The server matched this through a custom field: the title does not contain the query.
      {
        type: 'contact',
        uuid: 'u1',
        title: 'Nora Lane',
        subtitle: null,
        url: '/contacts/u1',
        score: 10,
        matched: 'Member number',
      },
    ],
  });
});
vi.mock('@/lib/api', () => ({ apiGet: (p: string) => apiGet(p) }));
vi.mock('@/app/session', () => ({
  useLabels: () => ({ contact: { singular: 'Member', plural: 'Members' } }),
  useT: () => (key: string, vars?: Record<string, unknown>) => i18n.t(key, vars),
}));

// cmdk measures its list; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const { CommandPaletteProvider, usePalette } = await import('./command-palette');

function Opener() {
  const { open } = usePalette();
  return <button onClick={() => open()}>open</button>;
}

describe('command palette', () => {
  it('shows server hits without re-filtering them, with the workspace name for the type', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CommandPaletteProvider baseCommands={[]}>
            <Opener />
          </CommandPaletteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('open'));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'M' } });
    fireEvent.change(input, { target: { value: 'MX' } });
    fireEvent.change(input, { target: { value: 'MX12' } });
    expect(apiGet).not.toHaveBeenCalled();
    expect(await screen.findByText('Nora Lane')).toBeTruthy();
    // Typed quickly: one request, for the final text only.
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet.mock.calls[0]![0]).toContain('q=MX12');
    expect(screen.getByText(/Member number · Member/)).toBeTruthy();
    expect(screen.getByText(/See all results/)).toBeTruthy();
  });
});
