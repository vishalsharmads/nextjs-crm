import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConsentSummaryDto } from '@app/shared';

let canUpdate = true;
const summary: ConsentSummaryDto = {
  current: [{ purposeKey: 'newsletter', purposeLabel: 'Newsletter', status: 'granted' }],
  history: [
    {
      purposeKey: 'newsletter',
      purposeLabel: 'Newsletter',
      status: 'granted',
      lawfulBasis: 'consent',
      source: 'form',
      textSnapshot: 'Send me the monthly newsletter.',
      textHash: 'x',
      recordedBy: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    },
  ],
  marketingOptOut: false,
  processingRestricted: true,
};
vi.mock('@/app/session', () => ({ useCan: () => () => canUpdate }));
vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(() => Promise.resolve(summary)),
  apiPost: vi.fn(),
}));
vi.mock('@/app/branding', () => ({ useBranding: () => ({ branding: { appName: 'CRM' } }) }));

const { ConsentPanel } = await import('./consent-panel');
const { ErasureReport } = await import('./privacy-page');
const { PublicFormPage } = await import('@/features/forms/public-form-page');

afterEach(cleanup);

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('consent panel', () => {
  it('shows current consent, the wording people saw and the restriction', async () => {
    wrap(<ConsentPanel entity="contact" uuid="u" resource="core.contacts" />);
    expect(await screen.findByText('Processing restricted')).toBeInTheDocument();
    expect(screen.getByText('Given')).toBeInTheDocument();
    expect(screen.getByText('“Send me the monthly newsletter.”')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('hides changes from people who cannot edit the record', async () => {
    canUpdate = false;
    wrap(<ConsentPanel entity="contact" uuid="u" resource="core.contacts" />);
    await screen.findByText('Given');
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    canUpdate = true;
  });
});

describe('erasure report', () => {
  it('lists what was cleared and what was kept', () => {
    render(
      <ErasureReport
        report={{
          mode: 'anonymize',
          cleared: { emailMessages: 2, 'portal.accounts': 1, jobs: 0 },
          retained: [{ area: 'invoices', reason: '3 record(s) kept for tax and contract law' }],
        }}
      />,
    );
    expect(screen.getByText('Email copies')).toBeInTheDocument();
    expect(screen.getByText('portal · accounts')).toBeInTheDocument();
    expect(screen.queryByText('Background jobs')).toBeNull();
    expect(screen.getByText(/kept for tax and contract law/)).toBeInTheDocument();
  });
});

describe('public form consent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts unticked and sends only what the person ticked', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, message: 'Thanks' }), { status: 200 }),
        );
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { apiGet } = await import('@/lib/api');
    vi.mocked(apiGet).mockImplementation(
      () =>
        Promise.resolve({
          uuid: 'f',
          appName: 'CRM',
          title: 'Enquiry',
          intro: '',
          submitLabel: 'Send',
          consentText: '',
          consents: [{ key: 'terms', text: 'I agree.', required: true }],
          fields: [],
        }) as never,
    );
    wrap(
      <MemoryRouter initialEntries={['/f/f']}>
        <Routes>
          <Route path="/f/:uuid" element={<PublicFormPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const box = await screen.findByRole('checkbox', { name: /I agree/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.consents).toEqual({ terms: true });
  });
});
