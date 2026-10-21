import { describe, expect, it } from 'vitest';
import { base32Encode, totpAt, verifyTotp } from '../src/lib/totp';

describe('totp (RFC 6238 SHA-1 vectors)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at %i s', (t, code) => {
    expect(totpAt(secret, t * 1000)).toBe(code);
  });
  it('tolerates one step of drift', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBe(false);
  });
});
