import { describe, expect, it } from 'vitest';
import type { BootstrapDto } from '@app/shared';
import { buildCreateTargets } from './nav';

function boot(opts: { isAdmin?: boolean; permissions?: string[]; leads?: boolean }): BootstrapDto {
  return {
    access: { isAdmin: opts.isAdmin ?? false, permissions: opts.permissions ?? [] },
    labels: {
      contact: { singular: 'Member', plural: 'Members' },
      organization: { singular: 'Company', plural: 'Companies' },
      lead: { singular: 'Enquiry', plural: 'Enquiries' },
    },
    settings: { features: { leads: opts.leads ?? true } },
  } as unknown as BootstrapDto;
}

describe('buildCreateTargets', () => {
  it('uses vocabulary labels and the list route with ?new=1', () => {
    const t = buildCreateTargets(boot({ isAdmin: true }));
    expect(t.map((x) => [x.label, x.to])).toEqual([
      ['New Member', '/contacts?new=1'],
      ['New Company', '/organizations?new=1'],
      ['New Enquiry', '/leads?new=1'],
    ]);
  });

  it('only offers what the user may create', () => {
    const t = buildCreateTargets(boot({ permissions: ['core.contacts.create'] }));
    expect(t.map((x) => x.key)).toEqual(['contact']);
  });

  it('hides leads when the feature is off', () => {
    const t = buildCreateTargets(boot({ isAdmin: true, leads: false }));
    expect(t.map((x) => x.key)).toEqual(['contact', 'organization']);
  });

  it('offers nothing without permission', () => {
    expect(buildCreateTargets(boot({}))).toEqual([]);
  });
});
