import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiPatch = vi.fn();
const apiPost = vi.fn();
vi.mock('@/app/session', () => ({
  useBoot: () => ({}),
  useT: () => (k: string) => k,
  useCan: () => () => true,
  bootstrapKey: [],
}));
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  apiGet: vi.fn(),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPatch: (...a: unknown[]) => apiPatch(...a),
}));

const { ModuleSettingsForm } = await import('./modules-pages');
import type { ModuleSettingsDto } from './modules-pages';

const settings: ModuleSettingsDto = {
  fields: [
    { key: 'endpoint', type: 'url', label: 'Endpoint', help: 'Where events go.', required: true },
    { key: 'token', type: 'secret', label: 'Token', help: 'Sent with each request.', required: false },
    {
      key: 'batch',
      type: 'number',
      label: 'Batch size',
      help: 'Events per request.',
      required: false,
      default: 10,
    },
    {
      key: 'mode',
      type: 'select',
      label: 'Mode',
      help: 'How to send.',
      required: false,
      options: [
        { value: 'all', label: 'Everything' },
        { value: 'some', label: 'Chosen events' },
      ],
    },
  ],
  values: { endpoint: 'https://a.example.com', token: { set: true }, batch: 10, mode: null },
  configured: true,
};

const renderForm = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ModuleSettingsForm moduleKey="demo" settings={settings} canTest />
    </QueryClientProvider>,
  );

describe('ModuleSettingsForm', () => {
  afterEach(cleanup);
  beforeEach(() => {
    apiPatch.mockReset().mockResolvedValue(settings);
    apiPost.mockReset().mockResolvedValue({ ok: true, message: 'Connected.' });
  });

  it('renders fields from the definitions and never shows a saved secret', () => {
    renderForm();
    expect(screen.getByLabelText(/Endpoint/)).toHaveValue('https://a.example.com');
    const token = screen.getByLabelText('Token');
    expect(token).toHaveValue('');
    expect(token).toHaveAttribute('placeholder', 'Saved. Type to replace it');
    expect(screen.getByText('Sent with each request.')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Chosen events' })).toBeInTheDocument();
  });

  it('sends only changed values, and an empty secret keeps the saved one', async () => {
    renderForm();
    await userEvent.clear(screen.getByLabelText('Batch size'));
    await userEvent.type(screen.getByLabelText('Batch size'), '25');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/modules/demo/settings', { batch: 25 }));
  });

  it('tests the connection with the values on screen', async () => {
    renderForm();
    await userEvent.type(screen.getByLabelText('Token'), 'new-token');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connected.');
    expect(apiPost).toHaveBeenCalledWith('/modules/demo/test', { token: 'new-token' });
  });
});
