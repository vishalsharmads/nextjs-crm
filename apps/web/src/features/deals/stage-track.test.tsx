import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { DealDto, LeadDto, StageDto } from '@app/shared';
import { qk } from '@/lib/query-keys';

const stage = (key: string, sortOrder: number, extra: Partial<StageDto> = {}): StageDto => ({
  uuid: `s-${key}`,
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  color: null,
  probability: 10,
  sortOrder,
  isWon: false,
  isLost: false,
  rottingDays: null,
  ...extra,
});
const stages = [
  stage('enquiry', 0),
  stage('tour', 1),
  stage('proposal', 2),
  stage('won', 3, { isWon: true }),
  stage('lost', 4, { isLost: true }),
];

const deal = {
  uuid: 'd1',
  title: 'Fable office',
  pipeline: { uuid: 'p1', name: 'Memberships' },
  stage: {
    uuid: 's-tour',
    key: 'tour',
    name: 'Tour',
    isWon: false,
    isLost: false,
    probability: 10,
    color: null,
  },
} as unknown as DealDto;

let permissions = ['core.deals.update'];
let lostReasons: string[] = [];
const patch = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastDismiss = vi.fn();

vi.mock('@/app/session', () => ({
  useBoot: () => ({
    pipelines: [{ uuid: 'p1', stages: [...stages].reverse() }],
    settings: { deals: { lostReasons } },
  }),
  useCan: () => (p: string) => permissions.includes(p),
  useT: () => (key: string) => (key === 'common.pipelineStages' ? 'Pipeline stages' : key),
}));
vi.mock('@/lib/api', () => ({ apiPatch: (...a: unknown[]) => patch(...a) }));
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    dismiss: (...a: unknown[]) => toastDismiss(...a),
  },
}));
vi.mock('./lost-reason-dialog', () => ({
  LostReasonDialog: ({ onConfirm }: { onConfirm: (reason: string) => void }) => (
    <div role="dialog" aria-label="Lost reason">
      <button onClick={() => onConfirm('Too expensive')}>Confirm lost</button>
    </div>
  ),
}));

const { StageTrack } = await import('./stage-track');

function Harness({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <Live />
    </QueryClientProvider>
  );
}
// Reads the deal from the query cache like the record page does, so optimistic updates show up.
function Live() {
  const q = useQuery({
    queryKey: qk.record('deals', 'd1'),
    queryFn: () => Promise.resolve(deal),
    initialData: deal,
  });
  return <StageTrack deal={q.data} />;
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(qk.record('deals', 'd1'), deal);
  render(<Harness client={client} />);
  return client;
}

const current = () => screen.getByRole('button', { current: 'step' });

beforeEach(() => {
  permissions = ['core.deals.update'];
  lostReasons = [];
  patch.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  toastDismiss.mockReset();
  toastSuccess.mockReturnValue('toast-1');
});
afterEach(cleanup);

describe('StageTrack', () => {
  it('lists the pipeline stages in order and marks the current one', () => {
    setup();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Enquiry',
      'Tour',
      'Proposal',
      'Won',
      'Lost',
    ]);
    expect(current()).toHaveTextContent('Tour');
  });

  it('moves the deal on click, updates at once, and offers undo', async () => {
    let resolve!: (d: unknown) => void;
    patch.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Proposal' }));
    // Optimistic: the marker has moved before the server has answered.
    expect(current()).toHaveTextContent('Proposal');
    expect(patch).toHaveBeenCalledWith('/deals/d1/stage', { uuid: 'd1', stageUuid: 's-proposal' });
    expect(toastSuccess).toHaveBeenCalledWith(
      'Moved to Proposal',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );
    resolve({ ...deal, stage: { ...deal.stage, uuid: 's-proposal', name: 'Proposal' } });
    await waitFor(() => expect(current()).toHaveTextContent('Proposal'));
  });

  it('undo moves the deal back to the stage it came from', async () => {
    patch.mockResolvedValue(deal);
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Proposal' }));
    const action = (toastSuccess.mock.calls[0]![1] as { action: { onClick: () => void } }).action;
    action.onClick();
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith('/deals/d1/stage', { uuid: 'd1', stageUuid: 's-tour' }),
    );
  });

  it('puts the marker back and says so when the move fails', async () => {
    patch.mockRejectedValue(new Error('Stage is locked'));
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Proposal' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Stage is locked'));
    // The "Moved to" toast, with its Undo, must not stay up for a move that did not happen.
    expect(toastDismiss).toHaveBeenCalledWith('toast-1');
    expect(current()).toHaveTextContent('Tour');
  });

  it('does nothing when the current stage is clicked', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Tour' }));
    expect(patch).not.toHaveBeenCalled();
  });

  it('asks for a reason before a lost stage when reasons are configured', async () => {
    lostReasons = ['Too expensive'];
    patch.mockResolvedValue(deal);
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Lost' }));
    expect(patch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm lost' }));
    expect(patch).toHaveBeenCalledWith('/deals/d1/stage', {
      uuid: 'd1',
      stageUuid: 's-lost',
      lostReason: 'Too expensive',
    });
  });

  it('moves straight to a lost stage when no reasons are configured', async () => {
    patch.mockResolvedValue(deal);
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Lost' }));
    expect(patch).toHaveBeenCalledWith('/deals/d1/stage', { uuid: 'd1', stageUuid: 's-lost' });
  });

  it('is read-only without permission to update deals', async () => {
    permissions = [];
    const user = userEvent.setup();
    setup();
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Proposal' }));
    expect(patch).not.toHaveBeenCalled();
  });

  it('moves a lead and offers conversion on its won stage', async () => {
    permissions = ['core.leads.update'];
    const lead = { ...deal, fullName: 'Lee', stageEnteredAt: null } as unknown as LeadDto;
    patch.mockResolvedValue(lead);
    const onConvert = vi.fn();
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <QueryClientProvider client={client}>
        <StageTrack lead={lead} onConvert={onConvert} />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Won' }));
    expect(patch).toHaveBeenCalledWith('/leads/d1/stage', { stageUuid: 's-won' });
    const action = (toastSuccess.mock.calls[0]![1] as { action: { label: string; onClick: () => void } })
      .action;
    expect(action.label).toBe('Convert');
    action.onClick();
    expect(onConvert).toHaveBeenCalled();
  });

  it('colors each stage from its theme token', () => {
    setup();
    const li = screen.getByRole('button', { name: 'Tour' }).closest('li')!;
    expect(li.style.getPropertyValue('--sc')).toBe('var(--stage-gray)');
  });
});
