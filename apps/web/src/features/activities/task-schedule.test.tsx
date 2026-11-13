import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReminderControl, RepeatControl, reminderOffset } from './task-schedule';

describe('repeat control', () => {
  afterEach(cleanup);

  it('turns repeating on and picks weekdays for weekly rules', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RepeatControl value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'weekly' } });
    expect(onChange).toHaveBeenLastCalledWith({ freq: 'weekly', interval: 1 });
    rerender(<RepeatControl value={{ freq: 'weekly', interval: 1 }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thursday' }));
    expect(onChange).toHaveBeenLastCalledWith({ freq: 'weekly', interval: 1, byWeekday: [4] });
    expect(screen.getByText(/Every week\. Completing it creates the next one\./)).toBeInTheDocument();
  });

  it('turns repeating off', () => {
    const onChange = vi.fn();
    render(<RepeatControl value={{ freq: 'daily', interval: 2 }} onChange={onChange} />);
    expect(screen.getByText(/Every 2 days/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('reminder control', () => {
  afterEach(cleanup);
  const due = '2026-11-20T10:00:00.000Z';

  it('sets a reminder relative to the due time', () => {
    const onChange = vi.fn();
    render(<ReminderControl dueAt={due} reminderAt={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Remind me'), { target: { value: '60' } });
    expect(onChange).toHaveBeenCalledWith('2026-11-20T09:00:00.000Z');
  });

  it('recognises presets and is disabled without a due date', () => {
    expect(reminderOffset(due, '2026-11-19T10:00:00.000Z')).toBe('1440');
    expect(reminderOffset(due, '2026-11-20T09:13:00.000Z')).toBe('custom');
    render(<ReminderControl dueAt={null} reminderAt={null} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Remind me')).toBeDisabled();
  });
});
