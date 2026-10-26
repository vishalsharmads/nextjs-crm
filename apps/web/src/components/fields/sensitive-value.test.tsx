import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SENSITIVE_MASK, type CustomFieldDef } from '@app/shared';

let canReveal = true;
const apiGet = vi.fn(() => Promise.resolve({ value: 'Type 2 diabetes' }));
vi.mock('@/app/session', () => ({ useCan: () => () => canReveal }));
vi.mock('@/lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...(a as [])) }));

const { SensitiveValue } = await import('./sensitive-value');
const def = {
  entity: 'contact',
  key: 'diagnosis',
  label: 'Diagnosis',
  sensitivity: 'special',
} as CustomFieldDef;
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

afterEach(() => {
  cleanup();
  canReveal = true;
  apiGet.mockClear();
});

describe('sensitive value', () => {
  it('shows the mask and reveals on request', async () => {
    wrap(<SensitiveValue def={def} uuid="u1" value={SENSITIVE_MASK} />);
    expect(screen.getByText(SENSITIVE_MASK)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal Diagnosis' }));
    expect(await screen.findByText('Type 2 diabetes')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/custom-fields/reveal', {
      entity: 'contact',
      uuid: 'u1',
      key: 'diagnosis',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Hide Diagnosis' }));
    expect(screen.getByText(SENSITIVE_MASK)).toBeInTheDocument();
  });

  it('offers no reveal without the permission, and a dash when empty', () => {
    canReveal = false;
    wrap(
      <>
        <SensitiveValue def={def} uuid="u1" value={SENSITIVE_MASK} />
        <SensitiveValue def={def} uuid="u2" value={undefined} />
      </>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
