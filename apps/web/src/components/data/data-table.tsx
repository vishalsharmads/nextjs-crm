import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  width?: number;
  sortable?: boolean;
  align?: 'start' | 'end';
}

export interface DataTableProps<T> {
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  sort?: string;
  onSortChange?: (sort: string | undefined) => void;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  onRowOpen?: (row: T) => void;
  /** Gives each row a real link, so Tab, Enter and open-in-new-tab work. A plain click still calls onRowOpen. */
  rowHref?: (row: T) => string;
  /** The column that carries the link; the first column when unset or hidden. */
  linkColumnId?: string;
  activeKey?: string | null;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  density?: 'comfortable' | 'compact';
  empty?: ReactNode;
}

/** Server-paginated table with sticky header/first column, sorting, selection and keyboard navigation. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  sort,
  onSortChange,
  selected,
  onSelectedChange,
  onRowOpen,
  rowHref,
  linkColumnId,
  activeKey,
  page,
  pageSize,
  total,
  onPageChange,
  density = 'comfortable',
  empty,
}: DataTableProps<T>) {
  const [cursor, setCursor] = useState(0);
  // The keyboard cursor stays hidden until the first key press or row click, so no row looks selected on load.
  const [cursorActive, setCursorActive] = useState(false);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const rowH = density === 'compact' ? 'h-8' : 'h-10';
  const sortField = sort?.replace(/^-/, '').split(',')[0];
  const sortDir = sort?.startsWith('-') ? 'desc' : 'asc';
  const selectable = !!onSelectedChange && !!selected;
  const keys = useMemo(() => (rows ?? []).map(rowKey), [rows, rowKey]);
  const linkIndex = Math.max(
    0,
    columns.findIndex((c) => c.id === linkColumnId),
  );

  useEffect(() => setCursor(0), [rows]);

  // j/k to move, Enter to open, x to select — only when focus is not in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        el.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
        el.closest('[role="dialog"]')
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey || !rows?.length) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        // The first press reveals the cursor on the first row instead of skipping past it.
        setCursor((c) => (cursorActive ? Math.min(c + 1, rows.length - 1) : 0));
        setCursorActive(true);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => (cursorActive ? Math.max(c - 1, 0) : 0));
        setCursorActive(true);
      } else if (e.key === 'Enter' && onRowOpen && cursorActive) {
        // Enter on a focused link or button keeps its own meaning.
        if (el.closest('a, button')) return;
        e.preventDefault();
        onRowOpen(rows[cursor]!);
      } else if (e.key === 'x' && selectable && cursorActive) {
        e.preventDefault();
        const k = keys[cursor]!;
        const next = new Set(selected);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        onSelectedChange!(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, cursorActive, keys, onRowOpen, selectable, selected, onSelectedChange]);

  useEffect(() => {
    if (cursorActive) bodyRef.current?.querySelectorAll('tr')[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor, cursorActive]);

  const toggleSort = (id: string) => {
    if (!onSortChange) return;
    if (sortField !== id) onSortChange(id);
    else if (sortDir === 'asc') onSortChange(`-${id}`);
    else onSortChange(undefined);
  };

  const allSelected = selectable && keys.length > 0 && keys.every((k) => selected!.has(k));
  const someSelected = selectable && keys.some((k) => selected!.has(k));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-table tabular-nums">
          <thead className="sticky top-0 z-10">
            <tr>
              {selectable ? (
                <th className="sticky start-0 z-20 w-10 border-b border-line bg-subtle ps-4">
                  <Checkbox
                    aria-label="Select all on this page"
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(v) =>
                      onSelectedChange!(
                        v
                          ? new Set([...selected!, ...keys])
                          : new Set([...selected!].filter((k) => !keys.includes(k))),
                      )
                    }
                  />
                </th>
              ) : null}
              {columns.map((c, i) => (
                <th
                  key={c.id}
                  scope="col"
                  style={{ minWidth: c.width, width: c.width }}
                  aria-sort={
                    sortField === c.id ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={cn(
                    'border-b border-line bg-subtle px-3 py-2 text-start text-xs font-medium whitespace-nowrap text-muted',
                    i === 0 && 'sticky z-20',
                    i === 0 && (selectable ? 'start-10' : 'start-0'),
                    c.align === 'end' && 'text-end',
                  )}
                >
                  {c.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.id)}
                      className="inline-flex items-center gap-1 hover:text-ink"
                    >
                      {c.header}
                      {sortField === c.id ? (
                        sortDir === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        )
                      ) : null}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {loading && !rows
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {selectable ? <td className="border-b border-line ps-4" /> : null}
                    {columns.map((c) => (
                      <td key={c.id} className={cn('border-b border-line px-3', rowH)}>
                        <Skeleton className="h-3.5 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows?.map((row, i) => {
                  const k = keys[i]!;
                  const isActive = activeKey === k;
                  const isCursor = cursorActive && cursor === i;
                  return (
                    <tr
                      key={k}
                      onClick={() => {
                        setCursor(i);
                        setCursorActive(true);
                        onRowOpen?.(row);
                      }}
                      className={cn(
                        'group cursor-default',
                        isActive ? 'bg-primary-soft' : 'bg-surface hover:bg-hover',
                        isCursor && !isActive && 'bg-hover',
                      )}
                      aria-selected={selected?.has(k)}
                    >
                      {selectable ? (
                        <td
                          className={cn('sticky start-0 z-[1] border-b border-line bg-inherit ps-4', rowH)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            aria-label="Select row"
                            checked={selected!.has(k)}
                            onCheckedChange={(v) => {
                              const next = new Set(selected);
                              if (v) next.add(k);
                              else next.delete(k);
                              onSelectedChange!(next);
                            }}
                          />
                        </td>
                      ) : null}
                      {columns.map((c, ci) => (
                        <td
                          key={c.id}
                          className={cn(
                            'max-w-80 overflow-hidden border-b border-line px-3 text-ellipsis whitespace-nowrap',
                            rowH,
                            ci === 0 && 'sticky z-[1] bg-inherit',
                            ci === 0 && (selectable ? 'start-10' : 'start-0'),
                            c.align === 'end' && 'text-end',
                            isCursor && ci === 0 && 'shadow-[inset_2px_0_0_var(--primary)]',
                          )}
                        >
                          {rowHref && ci === linkIndex ? (
                            <Link
                              to={rowHref(row)}
                              className="hover:underline"
                              onClick={(e) => {
                                // Modified clicks open the page; a plain click is the row's own (peek).
                                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
                                  e.stopPropagation();
                                  return;
                                }
                                e.preventDefault();
                              }}
                            >
                              {c.cell(row)}
                            </Link>
                          ) : (
                            c.cell(row)
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!loading && rows && !rows.length ? empty : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line bg-surface px-4 py-2 text-xs text-muted">
        <span className="tabular">{total ? `${from}–${to} of ${total.toLocaleString()}` : ''}</span>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="rtl:-scale-x-100" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={to >= total}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="rtl:-scale-x-100" />
          </Button>
        </div>
      </div>
    </div>
  );
}
