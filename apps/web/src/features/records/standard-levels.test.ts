import { describe, expect, it } from 'vitest';
import { buildConfig } from './entities';

const boot = (standardFields: object) =>
  ({
    labels: {},
    customFields: [],
    pipelines: [],
    recordTypes: [],
    me: { uuid: 'me' },
    settings: {
      general: { currency: 'USD' },
      features: { leads: true },
      deals: { lostReasons: [] },
      contacts: { sources: [], lifecycleStatuses: [] },
    },
    standardFields,
  }) as unknown as Parameters<typeof buildConfig>[1];

describe('standard field levels in the web config', () => {
  it('drops hidden fields everywhere and removes the input of read-only ones', () => {
    const plain = buildConfig('deal', boot({}));
    const config = buildConfig('deal', boot({ deal: { value: 'hidden', expected_close: 'read' } }));
    expect(plain.fields.some((f) => f.key === 'value')).toBe(true);
    expect(config.fields.some((f) => f.key === 'value')).toBe(false);
    expect(config.defaultColumns).not.toContain('value');
    expect(config.formInputs).not.toContain('value');
    const close = config.fields.find((f) => f.key === 'expected_close')!;
    expect(close.input).toBeUndefined();
    expect(config.formInputs).not.toContain('expectedClose');
  });
});
