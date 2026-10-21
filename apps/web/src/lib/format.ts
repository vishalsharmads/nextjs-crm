import type { GeneralSettings } from '@app/shared';

let settings: Pick<GeneralSettings, 'currency' | 'dateFormat' | 'locale' | 'timezone'> = {
  currency: 'USD',
  dateFormat: 'YYYY-MM-DD',
  locale: 'en',
  timezone: 'UTC',
};

/** Called when bootstrap loads so formatting follows workspace settings. */
export function setFormatSettings(s: typeof settings) {
  settings = s;
}

const locale = () => (typeof navigator !== 'undefined' ? navigator.language : settings.locale);

/** Money for summaries (whole amounts drop their decimals). Pass `exact` on documents, where cents always show. */
export function formatMoney(
  value: number | null | undefined,
  currency = settings.currency,
  exact = false,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  try {
    return new Intl.NumberFormat(locale(), {
      style: 'currency',
      currency,
      ...(exact ? { minimumFractionDigits: 2 } : {}),
      maximumFractionDigits: !exact && value % 1 === 0 ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(value);
}

function parts(d: Date, tz?: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Date-only values (YYYY-MM-DD) are rendered without timezone shifting. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const p = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { y: value.slice(0, 4), m: value.slice(5, 7), d: value.slice(8, 10) }
    : parts(new Date(value), settings.timezone);
  switch (settings.dateFormat) {
    case 'DD/MM/YYYY':
      return `${p.d}/${p.m}/${p.y}`;
    case 'MM/DD/YYYY':
      return `${p.m}/${p.d}/${p.y}`;
    case 'DD.MM.YYYY':
      return `${p.d}.${p.m}.${p.y}`;
    default:
      return `${p.y}-${p.m}-${p.d}`;
  }
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  const time = new Intl.DateTimeFormat(locale(), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: settings.timezone,
  }).format(d);
  return `${formatDate(value)} ${time}`;
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '';
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return formatDate(value);
}

/** Local `YYYY-MM-DDTHH:mm` for <input type="datetime-local"> from an ISO string. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

export const getFormatSettings = () => settings;
