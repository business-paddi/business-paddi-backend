import { durationToSeconds } from './duration';

describe('durationToSeconds', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['1d', 86400],
    ['1h', 3600],
    ['2w', 1209600],
    ['15M', 900],
    [' 15m ', 900],
  ])('parses %p as %p seconds', (input: string, expected: number) => {
    expect(durationToSeconds(input)).toBe(expected);
  });

  it.each(['', 'abc', '15', 'm', '1.5h', '-5m', '0s', '12x'])(
    'rejects %p',
    (input: string) => {
      expect(() => durationToSeconds(input)).toThrow(/Invalid token duration/);
    },
  );
});
