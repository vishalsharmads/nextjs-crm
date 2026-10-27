import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/app/session', () => ({ useBoot: () => ({}), useT: () => (k: string) => k, bootstrapKey: [] }));
vi.mock('@/app/branding', () => ({ useBranding: () => ({ branding: { demoAccounts: [] } }) }));
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  buildUrl: (p: string) => p,
}));

const { DemoIndustryPane } = await import('./general-page');

const renderPane = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DemoIndustryPane />
    </QueryClientProvider>,
  );

const info = {
  current: 'coworking',
  industries: [
    { slug: 'coworking', name: 'Coworking space' },
    { slug: 'law-firms', name: 'Law firm' },
  ],
  allowed: true,
  reason: null,
};

describe('DemoIndustryPane', () => {
  afterEach(cleanup);
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
  });

  it('stays hidden when the server is not a demo', async () => {
    apiGet.mockRejectedValue(new Error('Not found'));
    const { container } = renderPane();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/settings/demo'));
    expect(container).toBeEmptyDOMElement();
  });

  it('explains why switching is refused', async () => {
    apiGet.mockResolvedValue({ ...info, allowed: false, reason: 'Not a demo database.' });
    renderPane();
    expect(await screen.findByText('Not a demo database.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch industry' })).toBeDisabled();
  });

  it('starts on the current industry and needs the new one typed before switching', async () => {
    apiGet.mockResolvedValue(info);
    apiPost.mockReturnValue(new Promise(() => undefined));
    renderPane();
    const select = (await screen.findByLabelText('Industry')) as HTMLSelectElement;
    expect(select.value).toBe('coworking');
    expect(screen.getByRole('button', { name: 'Switch industry' })).toBeDisabled();
    await userEvent.selectOptions(select, 'law-firms');
    await userEvent.click(screen.getByRole('button', { name: 'Switch industry' }));
    const dialog = await screen.findByRole('dialog', { name: /switch the demo to law firm/i });
    const switchButton = within(dialog).getByRole('button', { name: 'Switch industry' }) as HTMLButtonElement;
    expect(switchButton.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Type law-firms to confirm'), 'law-firms');
    expect(switchButton.disabled).toBe(false);
    await userEvent.click(switchButton);
    expect(apiPost).toHaveBeenCalledWith('/settings/demo/switch', {
      industry: 'law-firms',
      confirm: 'law-firms',
    });
  });
});
