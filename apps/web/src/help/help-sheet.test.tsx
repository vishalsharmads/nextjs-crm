import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// A closed sheet can leave `pointer-events: none` on the body between tests.
const click = (el: Element) => userEvent.setup({ pointerEventsCheck: 0 }).click(el);
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const boot = {
  labels: { deal: { singular: 'Opportunity', plural: 'Opportunities' } },
  access: { isAdmin: false, permissions: ['core.deals.view'] },
  modules: { enabled: [] },
};
vi.mock('@/app/session', () => ({
  useBoot: () => boot,
  useCan: () => (p: string) => boot.access.permissions.includes(p),
  useT: () => (k: string) => k,
}));
vi.mock('@/app/branding', () => ({ useBranding: () => ({ branding: { appName: 'Brightdesk' } }) }));

const { HelpProvider, HelpButton } = await import('./help-context');
// Warm the lazily loaded sheet (every article) so a busy test run does not time out on it.
await import('./help-sheet');

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <HelpProvider onShortcuts={() => undefined}>
          <HelpButton />
        </HelpProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('page help', () => {
  it('opens the article for the page, in the workspace vocabulary', { timeout: 30_000 }, async () => {
    renderAt('/deals');
    await click(screen.getByRole('button', { name: 'Help for this page' }));
    const sheet = await screen.findByRole('dialog', { name: 'Opportunities' }, { timeout: 25_000 });
    expect(sheet.textContent).toContain('opportunities list');
    expect(sheet.textContent).not.toMatch(/\{\{/);
  });

  it('shows nothing a person may not open', async () => {
    renderAt('/settings/security');
    await click(screen.getByRole('button', { name: 'Help for this page' }));
    const sheet = await screen.findByRole('dialog', { name: 'Help' }, { timeout: 5000 });
    expect(sheet.textContent).toContain('no help for this page');
  });
});

describe('workspace notes', () => {
  it('render Markdown but never HTML or script links', async () => {
    const { ArticleView } = await import('./article-view');
    const { parseArticle } = await import('./registry');
    const article = parseArticle('---\nid: x\ntitle: X\n---\nBody', 'x.md');
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ArticleView
          article={article}
          vars={{}}
          note={
            '**Bold** <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [good](https://example.test)'
          }
        />
      </QueryClientProvider>,
    );
    const note = container.querySelector('section')!;
    expect(note.querySelector('strong')?.textContent).toBe('Bold');
    expect(note.querySelector('img')).toBeNull();
    const links = [...note.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['#', 'https://example.test']);
  });
});
