import { describe, expect, it } from 'vitest';
import { floorHint } from './compliance-floors';

describe('compliance floor hints', () => {
  it('explains governed settings only under the profile that governs them', () => {
    expect(floorHint('compliance', 'idleTimeoutMinutes', 'hipaa')).toMatch(/1 to 15/);
    expect(floorHint('security', 'passwordMinLength', 'hipaa')).toMatch(/at least 12/);
    expect(floorHint('compliance', 'idleTimeoutMinutes', 'standard')).toBeUndefined();
    expect(floorHint('security', 'lockoutMinutes', 'hipaa')).toBeUndefined();
  });
});
