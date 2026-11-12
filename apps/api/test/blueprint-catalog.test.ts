import { describe, expect, it } from 'vitest';
import {
  checkSampleData,
  demoBranding,
  industryForBlueprint,
  listBlueprintKeys,
  loadBlueprint,
  parseBlueprint,
} from '@app/blueprints';
import { checkPaletteContrast } from '@app/shared';
import { fillPlaceholders, workingDays } from '../src/blueprints/sample-data';
import { loadModules } from '../src/modules/registry';

/** Every shipped blueprint must parse, name only installed modules, and have consistent sample data. */
describe('blueprint catalog', () => {
  const modules = loadModules();
  const deps = Object.fromEntries(modules.map((m) => [m.manifest.key, m.manifest.depends_on]));

  for (const key of listBlueprintKeys()) {
    it(`${key} is valid and its sample data references only what exists`, () => {
      const bp = loadBlueprint(key);
      for (const m of bp.modules) expect(deps, `module "${m}"`).toHaveProperty(m);
      expect(checkSampleData(bp, deps)).toEqual([]);
    });

    it(`${key} demo brand is readable in light and dark mode`, () => {
      const branding = demoBranding(loadBlueprint(key));
      if (branding) expect(checkPaletteContrast(branding.colors)).toEqual([]);
    });
  }

  it('ships a template for every industry on the website', () => {
    const industries = [
      'real-estate',
      'healthcare-clinics',
      'law-firms',
      'financial-advisers',
      'construction-trades',
      'education-training',
      'recruitment-staffing',
      'immigration-visa',
      'coworking',
    ];
    expect(listBlueprintKeys().map(industryForBlueprint)).toEqual(expect.arrayContaining(industries));
  });
});

describe('sample data rules', () => {
  const base = () => structuredClone(loadBlueprint('coworking'));

  it('flags lead stages missing from the lead pipeline', () => {
    const bp = structuredClone(loadBlueprint('software-saas'));
    bp.sample_data!.leads[0]!.stage = 'nowhere';
    expect(checkSampleData(bp)).toContain('lead "park": unknown stage "nowhere"');
  });

  it('flags bad date placeholders and references outside requests', () => {
    const bp = base();
    bp.sample_data!.contacts[0]!.custom = { start: '{{datetime:+1@25}}', who: '{{contact:amara}}' };
    const problems = checkSampleData(bp);
    expect(problems.some((p) => p.includes('bad datetime "+1@25"'))).toBe(true);
    expect(problems.some((p) => p.includes('only works in requests'))).toBe(true);
  });

  it('rejects request paths that leave their prefix', () => {
    const bp = base() as unknown as Record<string, unknown>;
    const sample = bp.sample_data as { requests: unknown[] };
    sample.requests = [{ method: 'post', path: '/m/../auth/logout', body: {} }];
    expect(() => parseBlueprint(bp)).toThrow();
  });

  it('fills dates relative to today and refuses impossible times', () => {
    expect(fillPlaceholders('{{date:0}}', () => undefined)).toBe(new Date().toISOString().slice(0, 10));
    expect(fillPlaceholders('{{datetime:+1@14:30}}', () => undefined)).toMatch(/T14:30:00\.000Z$/);
    expect(() => fillPlaceholders('{{datetime:+1@24}}', () => undefined)).toThrow('bad datetime');
    expect(() => fillPlaceholders('{{date:soon}}', () => undefined)).toThrow('bad date');
    expect(() => fillPlaceholders('{{contact:nobody}}', () => undefined)).toThrow('unknown reference');
  });

  it('counts working days past weekends, so weekday-only rooms can always be booked', () => {
    const friday = new Date('2026-10-30T12:00:00Z');
    expect(workingDays(1, friday)).toBe(3); // Monday
    expect(workingDays(4, new Date('2026-10-27T12:00:00Z'))).toBe(6); // Tuesday + 4 → Monday
    expect(workingDays(-1, new Date('2026-11-02T12:00:00Z'))).toBe(-3); // Monday − 1 → Friday
    const day = new Date(fillPlaceholders('{{datetime:+4w@10}}', () => undefined) as string).getUTCDay();
    expect([0, 6]).not.toContain(day);
  });
});
