import { describe, expect, it } from 'vitest';
import { buildCustomSchema, type CustomFieldDef } from './custom-fields';
import { checkPaletteContrast, contrastRatio, DEFAULT_BRANDING, readableForeground } from './branding';
import { filterSchema } from './filters';
import { hasPermission } from './permissions';

const def = (p: Partial<CustomFieldDef>): CustomFieldDef => ({
  uuid: '00000000-0000-7000-8000-000000000000',
  entity: 'contact',
  key: 'k',
  label: 'K',
  type: 'text',
  group: null,
  options: [],
  currency: null,
  placeholder: null,
  helpText: null,
  required: false,
  defaultValue: null,
  validation: {},
  visibility: { default: 'write', roles: {} },
  filterable: false,
  showInList: false,
  sortOrder: 0,
  active: true,
  sourceBlueprint: null,
  customized: false,
  ...p,
});

describe('custom field schema', () => {
  const defs = [
    def({
      key: 'plan',
      type: 'select',
      required: true,
      options: [
        { key: 'a', label: 'A', active: true },
        { key: 'old', label: 'Old', active: false },
      ],
    }),
    def({ key: 'tags', type: 'multi_select', options: [{ key: 'x', label: 'X', active: true }] }),
    def({ key: 'fee', type: 'currency', validation: { min: 0 } }),
    def({ key: 'start', type: 'date' }),
    def({ key: 'phone', type: 'phone' }),
    def({ key: 'gone', type: 'text', active: false }),
  ];

  it('enforces required fields on create only', () => {
    expect(buildCustomSchema(defs, 'create').safeParse({}).success).toBe(false);
    expect(buildCustomSchema(defs, 'patch').safeParse({}).success).toBe(true);
  });

  it('rejects archived options, unknown keys and archived fields', () => {
    const s = buildCustomSchema(defs, 'patch');
    expect(s.safeParse({ plan: 'old' }).success).toBe(false);
    expect(s.safeParse({ nope: 1 }).success).toBe(false);
    expect(s.safeParse({ gone: 'x' }).success).toBe(false);
  });

  it('validates types and normalizes phone numbers', () => {
    const s = buildCustomSchema(defs, 'patch');
    expect(s.safeParse({ fee: -1 }).success).toBe(false);
    expect(s.safeParse({ start: '2026-13' }).success).toBe(false);
    expect(s.parse({ phone: '+44 (20) 7946-0958' })).toEqual({ phone: '+442079460958' });
    expect(s.safeParse({ tags: ['x'] }).success).toBe(true);
  });

  it('does not allow clearing a required field on patch', () => {
    expect(buildCustomSchema(defs, 'patch').safeParse({ plan: null }).success).toBe(false);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(Math.round(contrastRatio('#000000', '#FFFFFF'))).toBe(21);
    expect(readableForeground('#1F6F5C')).toBe('#FFFFFF');
    expect(readableForeground('#F5D90A')).toBe('#000000');
  });
  it('accepts the default palette', () => {
    expect(checkPaletteContrast(DEFAULT_BRANDING.colors)).toEqual([]);
  });
});

describe('filters and permissions', () => {
  it('limits filter depth', () => {
    const leaf = { field: 'a', op: 'eq', value: 1 };
    expect(filterSchema.safeParse({ and: [{ or: [leaf] }] }).success).toBe(true);
    expect(filterSchema.safeParse({ and: [{ or: [{ and: [{ or: [leaf] }] }] }] }).success).toBe(false);
  });
  it('matches wildcard patterns', () => {
    expect(hasPermission(['core.contacts.*'], 'core.contacts.view')).toBe(true);
    expect(hasPermission(['core.contacts.*'], 'core.deals.view')).toBe(false);
    expect(hasPermission(['*'], 'tickets.tickets.view')).toBe(true);
  });
});
