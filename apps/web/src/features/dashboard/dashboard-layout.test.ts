import { describe, expect, it } from 'vitest';
import { orderWidgets, type LayoutWidget } from './dashboard-layout';

const w = (type: string, size: LayoutWidget['size'] = 'sm'): LayoutWidget & { key: string } => ({
  key: type,
  type,
  size,
});

describe('orderWidgets', () => {
  it('puts the pipeline widget first and full width, keeping the rest in order', () => {
    const out = orderWidgets([w('tasks_due'), w('pipeline_value', 'md'), w('conversion')]);
    expect(out.map((x) => x.key)).toEqual(['pipeline_value', 'tasks_due', 'conversion']);
    expect(out[0]!.size).toBe('lg');
    expect(out[1]!.size).toBe('sm');
  });

  it('leaves the order alone when there is no pipeline widget', () => {
    const input = [w('tasks_due'), w('conversion')];
    expect(orderWidgets(input)).toBe(input);
  });

  it('does not change the stored widget objects', () => {
    const input = [w('tasks_due'), w('pipeline_value', 'md')];
    orderWidgets(input);
    expect(input[1]!.size).toBe('md');
  });

  it('moves only the first pipeline widget when a dashboard has several', () => {
    const out = orderWidgets([
      w('tasks_due'),
      w('pipeline_value'),
      { ...w('pipeline_value'), key: 'second' },
    ]);
    expect(out.map((x) => x.key)).toEqual(['pipeline_value', 'tasks_due', 'second']);
  });
});
