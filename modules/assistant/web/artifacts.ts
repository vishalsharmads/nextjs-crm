import type { ReportResultDto } from '@app/shared';

/** Spreadsheet formulas never run from an exported cell (same rule as the server's exports). */
const safe = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

/** A chart's data as CSV: one row per group, a column per breakdown when there is one. */
export function reportCsv(result: ReportResultDto, valueLabel = 'Value'): string {
  const series = result.series ?? [];
  const head = ['Group', ...(series.length ? series.map((c) => c.label) : []), valueLabel];
  const lines = result.rows.map((r) => [r.label, ...series.map((c) => r.breakdown?.[c.key] ?? 0), r.value]);
  return [head, ...lines].map((row) => row.map(safe).join(',')).join('\r\n');
}

/** Saves text as a file in the browser. */
export function download(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a title: letters, digits and dashes. */
export const fileName = (title: string, ext: string) =>
  `${
    (title || 'report')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'report'
  }.${ext}`;
