const DURATION_PATTERN = /^(\d+)(s|m|h|d|w)$/i;

const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
} as const;

export function durationToSeconds(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());

  if (!match) {
    throw new Error(`Invalid token duration: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase() as keyof typeof UNIT_SECONDS;
  const seconds = amount * UNIT_SECONDS[unit];

  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`Invalid token duration: ${value}`);
  }

  return seconds;
}
