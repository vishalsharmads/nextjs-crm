/**
 * Wall-clock helpers for a fixed IANA time zone (the workspace's), independent of the browser's.
 * Used where everyone must see the same local times, such as a shared bookings board.
 */

function parts(at: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    ms: Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    ),
  };
}

/** The zone's offset from UTC at an instant, in ms. */
const offset = (at: Date, timeZone: string) =>
  parts(at, timeZone).ms - Math.floor(at.getTime() / 1000) * 1000;

/** The instant when the zone's clock shows `date` (YYYY-MM-DD) at `time` (HH:MM). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let at = new Date(guess - offset(new Date(guess), timeZone));
  // Second pass settles DST transitions.
  at = new Date(guess - offset(at, timeZone));
  return at;
}

/** Date (YYYY-MM-DD) and time (HH:MM) the zone's clock shows at an instant. */
export const zonedParts = (at: Date, timeZone: string) => {
  const { date, time } = parts(at, timeZone);
  return { date, time };
};

/** `datetime-local` input value in the zone, and back. */
export const toZonedInput = (iso: string | Date, timeZone: string) => {
  const { date, time } = zonedParts(new Date(iso), timeZone);
  return `${date}T${time}`;
};
export const fromZonedInput = (value: string, timeZone: string) => {
  const [date, time] = value.split('T') as [string, string];
  return zonedToUtc(date, time.slice(0, 5), timeZone);
};

/** Add whole days to a YYYY-MM-DD string. */
export function addDaysTo(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
