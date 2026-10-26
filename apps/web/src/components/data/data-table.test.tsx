import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
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

function renderTable(onRowOpen = vi.fn(), withLinks = false) {
  render(
    <MemoryRouter>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.uuid}
        page={1}
        pageSize={50}
        total={rows.length}
        onPageChange={() => undefined}
        onRowOpen={onRowOpen}
        rowHref={withLinks ? (r) => `/contacts/${r.uuid}` : undefined}
      />
    </MemoryRouter>,
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

describe('DataTable row links', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(cleanup);

  it('renders the first column as a link to the record', () => {
    renderTable(vi.fn(), true);
    expect(screen.getByRole('link', { name: 'Mei' })).toHaveAttribute('href', '/contacts/b');
  });

  it('renders no links when rowHref is not set', () => {
    renderTable();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('opens the peek, not the page, on a plain click', async () => {
    const onRowOpen = renderTable(vi.fn(), true);
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Lukas' }));
    expect(onRowOpen).toHaveBeenCalledTimes(1);
    expect(onRowOpen).toHaveBeenCalledWith(rows[2]);
  });

  it('leaves a modified click to the browser (new tab) without opening the peek', async () => {
    const onRowOpen = renderTable(vi.fn(), true);
    const user = userEvent.setup();
    // On React's root node, registered after React's own listener: record whether the link's default
    // survived, then stop jsdom navigating.
    const root = document.body.firstElementChild!;
    let defaultKept = false;
    const probe = (e: Event) => {
      defaultKept = !e.defaultPrevented;
      e.preventDefault();
    };
    root.addEventListener('click', probe);
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('link', { name: 'Lukas' }));
    await user.keyboard('{/Control}');
    root.removeEventListener('click', probe);
    expect(defaultKept).toBe(true);
    expect(onRowOpen).not.toHaveBeenCalled();
  });

  it('reaches a row link with Tab and opens it with Enter', async () => {
    const onRowOpen = renderTable(vi.fn(), true);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Robin' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onRowOpen).toHaveBeenCalledWith(rows[0]);
  });
});
