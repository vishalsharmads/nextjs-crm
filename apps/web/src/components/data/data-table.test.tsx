import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, type Column } from './data-table';

interface Row {
  uuid: string;
  name: string;
}
const rows: Row[] = [
  { uuid: 'a', name: 'Robin' },
  { uuid: 'b', name: 'Mei' },
  { uuid: 'c', name: 'Lukas' },
];
const columns: Column<Row>[] = [{ id: 'name', header: 'Name', cell: (r) => r.name }];

function renderTable(onRowOpen = vi.fn()) {
  render(
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.uuid}
      page={1}
      pageSize={50}
      total={rows.length}
      onPageChange={() => undefined}
      onRowOpen={onRowOpen}
    />,
  );
  return onRowOpen;
}

const bodyRows = () => screen.getAllByRole('row').slice(1);
const hasCursor = (row: HTMLElement) => row.querySelector('td')?.className.includes('inset_2px_0_0') ?? false;

describe('DataTable keyboard cursor', () => {
  beforeEach(() => {
    // jsdom has no layout, so it does not implement scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(cleanup);

  it('shows no cursor until the first key press', () => {
    renderTable();
    expect(bodyRows().some(hasCursor)).toBe(false);
  });

  it('reveals the cursor on the first row, then moves it', async () => {
    renderTable();
    const user = userEvent.setup();
    await user.keyboard('j');
    expect(hasCursor(bodyRows()[0]!)).toBe(true);
    await user.keyboard('j');
    expect(hasCursor(bodyRows()[1]!)).toBe(true);
    expect(hasCursor(bodyRows()[0]!)).toBe(false);
  });

  it('ignores Enter until the cursor is active, then opens the cursor row', async () => {
    const onRowOpen = renderTable();
    const user = userEvent.setup();
    await user.keyboard('{Enter}');
    expect(onRowOpen).not.toHaveBeenCalled();
    await user.keyboard('j{Enter}');
    expect(onRowOpen).toHaveBeenCalledWith(rows[0]);
  });

  it('shows the cursor on a clicked row', async () => {
    renderTable();
    const user = userEvent.setup();
    await user.click(screen.getByText('Lukas'));
    expect(hasCursor(bodyRows()[2]!)).toBe(true);
  });
});
