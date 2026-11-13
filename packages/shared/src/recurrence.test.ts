import { describe, expect, it } from 'vitest';
import { describeRecurrence, nextOccurrence, nextRule, recurrenceSchema } from './recurrence';

const rule = (r: object) => recurrenceSchema.parse(r);
const at = (s: string) => new Date(s);

describe('nextOccurrence', () => {
  it('steps daily and keeps the local time across a daylight saving change', () => {
    // 09:00 in New York on 2026-03-07 (EST, UTC−5); the next day is EDT (UTC−4).
    const next = nextOccurrence(at('2026-03-07T14:00:00Z'), rule({ freq: 'daily' }), 'America/New_York');
    expect(next?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('repeats weekly on chosen weekdays, every n-th week', () => {
    const r = rule({ freq: 'weekly', interval: 2, byWeekday: [1, 4] }); // Mon, Thu
    // Monday 2026-11-02 09:00 UTC → Thursday the 5th, then Monday the 16th (skipping a week).
    const thu = nextOccurrence(at('2026-11-02T09:00:00Z'), r, 'UTC')!;
    expect(thu.toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(nextOccurrence(thu, r, 'UTC')?.toISOString()).toBe('2026-11-16T09:00:00.000Z');
  });

  it('clamps monthly repeats to the last day of shorter months', () => {
    const next = nextOccurrence(at('2026-01-31T10:00:00Z'), rule({ freq: 'monthly' }), 'UTC');
    expect(next?.toISOString()).toBe('2026-02-28T10:00:00.000Z');
  });

  it('skips occurrences already in the past', () => {
    const next = nextOccurrence(
      at('2026-01-01T10:00:00Z'),
      rule({ freq: 'weekly' }),
      'UTC',
      at('2026-01-20T00:00:00Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-22T10:00:00.000Z');
  });

  it('ends at until and after count', () => {
    expect(
      nextOccurrence(at('2026-05-30T10:00:00Z'), rule({ freq: 'daily', until: '2026-05-30' }), 'UTC'),
    ).toBeNull();
    expect(nextOccurrence(at('2026-05-30T10:00:00Z'), rule({ freq: 'daily', count: 1 }), 'UTC')).toBeNull();
    expect(nextRule(rule({ freq: 'daily', count: 3 })).count).toBe(2);
  });
});

describe('recurrence rules', () => {
  it('refuses weekdays on non-weekly rules and describes rules in words', () => {
    expect(recurrenceSchema.safeParse({ freq: 'daily', byWeekday: [1] }).success).toBe(false);
    expect(describeRecurrence(rule({ freq: 'weekly', interval: 2, byWeekday: [4, 1] }))).toBe(
      'Every 2 weeks on Mon, Thu',
    );
  });
});
