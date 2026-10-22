import { describe, expect, it } from 'vitest';
import { addDaysTo, fromZonedInput, toZonedInput, zonedToUtc } from './zoned';

describe('zoned time', () => {
  it('converts wall-clock times in a zone to instants and back', () => {
    expect(zonedToUtc('2031-01-06', '09:00', 'Europe/Paris').toISOString()).toBe('2031-01-06T08:00:00.000Z');
    expect(zonedToUtc('2031-07-07', '09:00', 'Europe/Paris').toISOString()).toBe('2031-07-07T07:00:00.000Z');
    expect(zonedToUtc('2031-01-06', '09:00', 'Asia/Kolkata').toISOString()).toBe('2031-01-06T03:30:00.000Z');
    expect(toZonedInput('2031-01-06T08:00:00.000Z', 'Europe/Paris')).toBe('2031-01-06T09:00');
    expect(fromZonedInput('2031-01-06T09:00', 'UTC').toISOString()).toBe('2031-01-06T09:00:00.000Z');
    expect(addDaysTo('2031-02-28', 1)).toBe('2031-03-01');
  });
});
