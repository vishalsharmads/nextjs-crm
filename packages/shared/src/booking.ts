import { z } from 'zod';
import { wallClock, zonedTime } from './recurrence';

/** Scheduling links: a person's public page where customers book a meeting in their free time. */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export const meetingTypeSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(100),
  durationMin: z.number().int().min(10).max(480),
  /** Free time kept before and after. */
  bufferMin: z.number().int().min(0).max(120).default(0),
  /** How soon the earliest booking may start. */
  noticeHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 14)
    .default(4),
  /** How far ahead bookings are offered. */
  horizonDays: z.number().int().min(1).max(180).default(30),
  questions: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]{1,40}$/),
        label: z.string().trim().min(1).max(200),
        required: z.boolean().default(false),
      }),
    )
    .max(10)
    .default([]),
});
export type MeetingType = z.output<typeof meetingTypeSchema>;

export const bookingPageSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,59}$/, 'Use 3–60 lowercase letters, digits and hyphens'),
  title: z.string().trim().min(1).max(150),
  intro: z.string().trim().max(2000).default(''),
  timeZone: z.string().min(1).max(64),
  /** Working hours per weekday, as [start, end] pairs of HH:MM in the page's time zone. */
  hours: z.partialRecord(z.enum(WEEKDAYS), z.array(z.tuple([time, time])).max(4)),
  meetingTypes: z.array(meetingTypeSchema).min(1).max(10),
  active: z.boolean().default(true),
});
export type BookingPageInput = z.output<typeof bookingPageSchema>;

export interface Interval {
  start: Date;
  end: Date;
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Bookable start times (UTC) for one meeting type: inside working hours in the page's time zone,
 * not before the notice period or after the horizon, every `stepMin` minutes, and never touching a
 * busy interval once the buffer is added on both sides. Daylight-saving changes are handled through
 * wall-clock conversion per day.
 */
export function computeSlots(opts: {
  hours: BookingPageInput['hours'];
  timeZone: string;
  type: Pick<MeetingType, 'durationMin' | 'bufferMin' | 'noticeHours' | 'horizonDays'>;
  busy: Interval[];
  now: Date;
  stepMin?: number;
}): Date[] {
  const step = opts.stepMin ?? 15;
  const earliest = opts.now.getTime() + opts.type.noticeHours * 3600_000;
  const latest = opts.now.getTime() + opts.type.horizonDays * 86_400_000;
  const dur = opts.type.durationMin * 60_000;
  const buf = opts.type.bufferMin * 60_000;
  const busy = opts.busy.map((b) => [b.start.getTime() - buf, b.end.getTime() + buf] as const);
  const out: Date[] = [];
  const today = wallClock(opts.now, opts.timeZone);
  for (let i = 0; i <= opts.type.horizonDays; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const w = { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate() };
    const ranges = opts.hours[WEEKDAYS[day.getUTCDay()]!] ?? [];
    for (const [from, to] of ranges) {
      for (let min = toMinutes(from); min + opts.type.durationMin <= toMinutes(to); min += step) {
        const start = zonedTime({ ...w, hh: Math.floor(min / 60), mm: min % 60 }, opts.timeZone).getTime();
        const end = start + dur;
        if (start < earliest || start > latest) continue;
        if (busy.some(([bs, be]) => start < be && end > bs)) continue;
        out.push(new Date(start));
      }
    }
  }
  return out;
}
