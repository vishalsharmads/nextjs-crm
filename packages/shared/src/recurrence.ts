import { z } from 'zod';

export const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];

/**
 * How a task repeats. Completing it creates the next one. `count` is how many occurrences are
 * left including this one (each copy carries count − 1); `until` is the last allowed local date.
 */
export const recurrenceSchema = z
  .object({
    freq: z.enum(RECURRENCE_FREQS),
    interval: z.number().int().min(1).max(365).default(1),
    /** Weekly only: 0 = Sunday … 6 = Saturday. */
    byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    until: z.iso.date().optional(),
    count: z.number().int().min(1).max(1000).optional(),
  })
  .refine((r) => !r.byWeekday?.length || r.freq === 'weekly', {
    message: 'Weekdays apply to weekly repeats only',
    path: ['byWeekday'],
  });
export type Recurrence = z.output<typeof recurrenceSchema>;

interface Wall {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
}

/** Wall-clock parts of an instant in a time zone. */
export function wallClock(at: Date, timeZone: string): Wall {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { y: +parts.year!, m: +parts.month!, d: +parts.day!, hh: +parts.hour!, mm: +parts.minute! };
}

/** The UTC instant of a wall-clock time in a time zone (handles daylight saving). */
export function zonedTime(w: Wall, timeZone: string): Date {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
  const seen = wallClock(new Date(guess), timeZone);
  const offset = Date.UTC(seen.y, seen.m - 1, seen.d, seen.hh, seen.mm) - guess;
  const first = new Date(guess - offset);
  // Across a DST change the offset at the answer can differ from the guess: correct once.
  const again = wallClock(first, timeZone);
  const drift = Date.UTC(again.y, again.m - 1, again.d, again.hh, again.mm) - guess;
  return drift ? new Date(first.getTime() - drift) : first;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNumber = (w: Pick<Wall, 'y' | 'm' | 'd'>) => Math.floor(Date.UTC(w.y, w.m - 1, w.d) / 86_400_000);
const fromDayNumber = (n: number) => {
  const d = new Date(n * 86_400_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
const iso = (w: Pick<Wall, 'y' | 'm' | 'd'>) =>
  `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;

/** One step of the rule from a local date (time of day is kept by the caller). */
function step(w: Wall, r: Recurrence, anchorDay: number): Wall {
  const n = r.interval;
  if (r.freq === 'daily') return { ...w, ...fromDayNumber(dayNumber(w) + n) };
  if (r.freq === 'weekly') {
    const days = [...new Set(r.byWeekday ?? [])].sort();
    if (!days.length) return { ...w, ...fromDayNumber(dayNumber(w) + 7 * n) };
    // Weeks start on Sunday; only every n-th week (counted from the anchor's week) qualifies.
    const weekStart = (day: number) => day - ((day + 4) % 7); // day 0 (1970-01-01) was a Thursday
    const anchorWeek = weekStart(anchorDay);
    for (let day = dayNumber(w) + 1; day <= dayNumber(w) + 7 * n + 7; day++) {
      const weekday = (day + 4) % 7;
      const weeks = (weekStart(day) - anchorWeek) / 7;
      if (days.includes(weekday) && weeks % n === 0) return { ...w, ...fromDayNumber(day) };
    }
    return { ...w, ...fromDayNumber(dayNumber(w) + 7 * n) };
  }
  const months = r.freq === 'monthly' ? n : 12 * n;
  const total = w.y * 12 + (w.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  // The 31st becomes the last day of shorter months.
  const anchor = fromDayNumber(anchorDay).d;
  return { ...w, y, m, d: Math.min(anchor, daysIn(y, m)) };
}

/**
 * The next occurrence after `from` (an occurrence's due time), in the workspace time zone so the
 * local time of day survives daylight saving changes. Occurrences that would already be past
 * `notBefore` are skipped, so completing an old task does not create a pile of overdue ones.
 * Returns null when the series has ended.
 */
export function nextOccurrence(
  from: Date,
  rule: Recurrence,
  timeZone: string,
  notBefore: Date = from,
): Date | null {
  if (rule.count !== undefined && rule.count <= 1) return null;
  const start = wallClock(from, timeZone);
  const anchorDay = dayNumber(start);
  let w = start;
  for (let i = 0; i < 1000; i++) {
    w = step(w, rule, anchorDay);
    if (rule.until && iso(w) > rule.until) return null;
    const at = zonedTime(w, timeZone);
    if (at > notBefore) return at;
  }
  return null;
}

/** The rule the next occurrence carries (one fewer left when counted). */
export function nextRule(rule: Recurrence): Recurrence {
  return rule.count === undefined ? rule : { ...rule, count: rule.count - 1 };
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Every 2 weeks on Mon, Thu" — plain English summary for the UI. */
export function describeRecurrence(rule: Recurrence): string {
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[rule.freq];
  let s = rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  if (rule.freq === 'weekly' && rule.byWeekday?.length)
    s += ` on ${[...rule.byWeekday]
      .sort()
      .map((d) => WEEKDAY_NAMES[d])
      .join(', ')}`;
  if (rule.until) s += `, until ${rule.until}`;
  if (rule.count !== undefined) s += `, ${rule.count} left`;
  return s;
}
