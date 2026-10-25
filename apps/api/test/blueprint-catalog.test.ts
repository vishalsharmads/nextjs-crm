import { describe, expect, it } from 'vitest';
import { checkSampleData, industryForBlueprint, listBlueprintKeys, loadBlueprint } from '@app/blueprints';
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
