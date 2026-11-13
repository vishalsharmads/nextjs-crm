import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import type { DealDto } from '@app/shared';

vi.mock('@/app/session', () => ({
  useBoot: () => ({ settings: { deals: { lostReasons: [] } } }),
  useCan: () => () => true,
  useT: () => (key: string) => key,
}));
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPatch: vi.fn() }));

const { BoardColumn } = await import('./pipeline-board');

const stage = {
  uuid: 's1',
  key: 'tour',
  name: 'Tour booked',
  color: null,
  probability: 10,
  isWon: false,
  isLost: false,
  rottingDays: null,
};
const deal = (uuid: string, title: string) =>
  ({
    uuid,
    title,
    value: 100,
    currency: 'GBP',
    rotting: false,
    expectedClose: null,
    owner: null,
  }) as unknown as DealDto;

function renderColumn(props: { deals: DealDto[]; dragging?: boolean; settledId?: string | null }) {
  return render(
    <DndContext>
      <BoardColumn
        column={{ stage, count: props.deals.length, total: 0, records: props.deals }}
        onOpen={() => undefined}
        disabled={false}
        dragging={props.dragging ?? false}
        settledId={props.settledId ?? null}
      />
    </DndContext>,
  );
}

afterEach(cleanup);

describe('BoardColumn', () => {
  it('shows the drop hint in an empty column only while a card is being dragged', () => {
    renderColumn({ deals: [] });
    expect(screen.queryByText('Drop here')).toBeNull();
    cleanup();
    renderColumn({ deals: [], dragging: true });
    expect(screen.getByText('Drop here')).toBeInTheDocument();
  });

  it('never shows the drop hint in a column that has cards', () => {
    renderColumn({ deals: [deal('d1', 'Fable office')], dragging: true });
    expect(screen.queryByText('Drop here')).toBeNull();
  });

  it('highlights only the card that was just moved', () => {
    renderColumn({ deals: [deal('d1', 'Fable office'), deal('d2', 'Northwind desks')], settledId: 'd2' });
    expect(screen.getByText('Northwind desks').closest('article')).toHaveClass('anim-settle');
    expect(screen.getByText('Fable office').closest('article')).not.toHaveClass('anim-settle');
  });

  it('moves a card to another stage from its menu', async () => {
    const onMoveTo = vi.fn();
    const won = { ...stage, uuid: 's2', key: 'won', name: 'Signed', isWon: true };
    const column = { stage, count: 1, total: 0, records: [deal('d1', 'Fable office')] };
    const target = { stage: won, count: 0, total: 0, records: [] };
    render(
      <DndContext>
        <BoardColumn
          column={column}
          stages={[column, target]}
          onMoveTo={onMoveTo}
          onOpen={() => undefined}
          disabled={false}
          dragging={false}
          settledId={null}
        />
      </DndContext>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Move to stage' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Move to Signed/ }));
    expect(onMoveTo).toHaveBeenCalledWith(column.records[0], target);
  });
});
