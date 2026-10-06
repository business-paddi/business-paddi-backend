import { isPrivateIpAddress, normalizeIpAddress } from './ip-address';

describe('normalizeIpAddress', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['  8.8.8.8  ', '8.8.8.8'],
    ['::ffff:197.210.29.1', '197.210.29.1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['::1', '::1'],
  ])('normalizes %p to %p', (input: string | null, expected: string) => {
    expect(normalizeIpAddress(input)).toBe(expected);
  });

  it.each([null, '', 'not-an-ip', '999.1.1.1'])(
    'returns null for %p',
    (input: string | null) => {
      expect(normalizeIpAddress(input)).toBeNull();
    },
  );
});

describe('isPrivateIpAddress', () => {
  it.each(['10.1.2.3', '127.0.0.1', '192.168.0.10', '172.16.5.4', '::1'])(
    'treats %p as private',
    (input: string) => {
      expect(isPrivateIpAddress(input)).toBe(true);
    },
  );

  it.each(['8.8.8.8', '197.210.29.1', '105.112.0.1'])(
    'treats %p as public',
    (input: string) => {
      expect(isPrivateIpAddress(input)).toBe(false);
    },
  );
});
