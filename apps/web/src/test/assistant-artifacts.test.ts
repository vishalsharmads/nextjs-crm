import { describe, expect, it } from 'vitest';
import { fileName, reportCsv } from '../../../../modules/assistant/web/artifacts';

describe('assistant chart export', () => {
  it('writes one row per group, quoting and guarding cells', () => {
    const csv = reportCsv({
      entity: 'deal',
      total: 3,
      rows: [
        { key: 'a', label: 'Won, finally', value: 2 },
        { key: 'b', label: '=HYPERLINK("x")', value: 1 },
      ],
    });
    expect(csv.split('\r\n')).toEqual(['Group,Value', '"Won, finally",2', `"'=HYPERLINK(""x"")",1`]);
  });

  it('adds a column per breakdown', () => {
    const csv = reportCsv({
      entity: 'deal',
      total: 3,
      series: [{ key: 'x', label: 'X' }],
      rows: [{ key: 'a', label: 'A', value: 3, breakdown: { x: 3 } }],
    });
    expect(csv.split('\r\n')).toEqual(['Group,X,Value', 'A,3,3']);
  });

  it('names files from titles', () => {
    expect(fileName('Deals by stage!', 'csv')).toBe('deals-by-stage.csv');
    expect(fileName('', 'csv')).toBe('report.csv');
  });
});
