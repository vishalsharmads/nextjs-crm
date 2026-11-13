import { useState } from 'react';
import { describeRecurrence, type Recurrence, type RecurrenceFreq } from '@app/shared';
import { cn } from '@/lib/cn';
import { Input, NativeSelect } from '@/components/ui/input';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Repeat rule editor: frequency, interval and (weekly) weekdays. Emits null for "does not repeat". */
export function RepeatControl({
  value,
  onChange,
  disabled,
}: {
  value: Recurrence | null;
  onChange: (v: Recurrence | null) => void;
  disabled?: boolean;
}) {
  const [interval, setInterval] = useState(String(value?.interval ?? 1));
  const set = (patch: Partial<Recurrence>) => value && onChange({ ...value, ...patch } as Recurrence);
  return (
    <div className="flex flex-col gap-2">
      <NativeSelect
        aria-label="Repeat"
        value={value?.freq ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const freq = e.target.value as RecurrenceFreq | '';
          onChange(freq ? { freq, interval: value?.interval ?? 1 } : null);
        }}
      >
        <option value="">Does not repeat</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </NativeSelect>
      {value ? (
        <>
          <label className="flex items-center gap-2 text-sm text-muted">
            Every
            <Input
              type="number"
              min={1}
              max={365}
              value={interval}
              disabled={disabled}
              aria-label="Repeat interval"
              className="w-20"
              onChange={(e) => setInterval(e.target.value)}
              onBlur={() => {
                const n = Math.min(365, Math.max(1, Math.round(Number(interval) || 1)));
                setInterval(String(n));
                if (n !== value.interval) set({ interval: n });
              }}
            />
            {{ daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[value.freq]}
          </label>
          {value.freq === 'weekly' ? (
            <div className="flex gap-1" role="group" aria-label="Repeat on">
              {WEEKDAYS.map((d, i) => {
                const on = value.byWeekday?.includes(i) ?? false;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={disabled}
                    aria-pressed={on}
                    aria-label={WEEKDAY_NAMES[i]}
                    onClick={() => {
                      const days = on
                        ? (value.byWeekday ?? []).filter((x) => x !== i)
                        : [...(value.byWeekday ?? []), i];
                      set({ byWeekday: days.length ? days.sort() : undefined });
                    }}
                    className={cn(
                      'size-8 rounded-full border text-xs transition-colors duration-150 ease-out',
                      on
                        ? 'border-primary bg-primary text-primary-fg'
                        : 'border-line text-muted hover:text-ink',
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          ) : null}
          <p className="text-xs text-muted">
            {describeRecurrence(value)}. Completing it creates the next one.
          </p>
        </>
      ) : null}
    </div>
  );
}

export const REMINDER_OPTIONS: [string, string, number | null][] = [
  ['none', 'No reminder', null],
  ['0', 'At due time', 0],
  ['15', '15 minutes before', 15],
  ['60', '1 hour before', 60],
  ['1440', '1 day before', 1440],
];

/** Minutes between a reminder and its due time, when it matches a preset. */
export function reminderOffset(dueAt: string | null, reminderAt: string | null): string {
  if (!reminderAt) return 'none';
  if (!dueAt) return 'custom';
  const mins = Math.round((new Date(dueAt).getTime() - new Date(reminderAt).getTime()) / 60_000);
  return REMINDER_OPTIONS.some(([k]) => k === String(mins)) ? String(mins) : 'custom';
}

/** "Remind me" select: sets the reminder relative to the due time. */
export function ReminderControl({
  dueAt,
  reminderAt,
  onChange,
  disabled,
}: {
  dueAt: string | null;
  reminderAt: string | null;
  onChange: (reminderAt: string | null) => void;
  disabled?: boolean;
}) {
  const current = reminderOffset(dueAt, reminderAt);
  return (
    <NativeSelect
      aria-label="Remind me"
      value={current}
      disabled={disabled || (!dueAt && !reminderAt)}
      title={!dueAt ? 'Set a due date first' : undefined}
      onChange={(e) => {
        const opt = REMINDER_OPTIONS.find(([k]) => k === e.target.value);
        if (!opt) return;
        const mins = opt[2];
        onChange(
          mins === null || !dueAt ? null : new Date(new Date(dueAt).getTime() - mins * 60_000).toISOString(),
        );
      }}
    >
      {REMINDER_OPTIONS.map(([k, label]) => (
        <option key={k} value={k}>
          {label}
        </option>
      ))}
      {current === 'custom' ? <option value="custom">Custom</option> : null}
    </NativeSelect>
  );
}
