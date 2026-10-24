import { describe, expect, it } from 'vitest';
import { appUrl, basePath } from './app-url';

describe('app URLs', () => {
  it('builds absolute page URLs from the build base path', () => {
    // Tests build with the default base ('/'), as client instances do.
    expect(basePath).toBe('');
    expect(appUrl('/f/abc')).toBe(`${window.location.origin}/f/abc`);
  });
});
