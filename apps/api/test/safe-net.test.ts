import { describe, expect, it } from 'vitest';
import { isPrivateAddress, safePost } from '../src/lib/safe-net';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.20.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::FFFF:7f00:1',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '::a9fe:a9fe',
    'not-an-ip',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('safePost', () => {
  it('refuses a host that resolves to a private address at connect time', async () => {
    await expect(safePost('http://localhost:9/', {}, '{}')).rejects.toThrow(/not reachable/);
  });
});
