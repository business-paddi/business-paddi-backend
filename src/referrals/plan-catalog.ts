import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

export const PLAN_KEYS = [
  'starter',
  'growth',
  'standard',
  'efficient',
] as const;
export const BILLING_MODES = ['monthly', 'annually'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export type BillingMode = (typeof BILLING_MODES)[number];
export const FIRST_PAYMENT_RATE_BPS = 1000;
export const MAX_MINOR = 9007199254740991n;
export function roundRatio(
  amount: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (amount < 0n || numerator < 0n || denominator <= 0n)
    throw new BadRequestException(
      'Amounts must be nonnegative integer minor units.',
    );
  return (amount * numerator + denominator / 2n) / denominator;
}
export function commission(amount: bigint) {
  return roundRatio(amount, 1000n, 10000n);
}
export function reversalTarget(
  original: bigint,
  refunded: bigint,
  eligible: bigint,
) {
  if (refunded < 0n || eligible <= 0n || refunded > eligible)
    throw new BadRequestException('Invalid settled refund amount.');
  return roundRatio(original, refunded, eligible);
}
export function planAmount(plan: PlanKey, mode: BillingMode): number | null {
  const monthly =
    plan === 'growth'
      ? 1877n
      : plan === 'standard'
        ? 4130n
        : plan === 'starter'
          ? 0n
          : null;
  return monthly === null
    ? null
    : Number(
        mode === 'annually' ? roundRatio(monthly * 12n, 85n, 100n) : monthly,
      );
}
export function catalog() {
  return {
    currency: 'USD',
    currencyExponent: 2,
    annualDiscountBps: 1500,
    plans: PLAN_KEYS.map((key) => ({
      key,
      trialDays: key === 'starter' ? 14 : null,
      monthlyMinor: planAmount(key, 'monthly'),
      annuallyMinor: planAmount(key, 'annually'),
      customQuote: key === 'efficient',
      checkoutAvailable: false,
    })),
  };
}
// These identifiers are server configuration only; never supplied by a checkout client.
export function providerPriceId(
  config: ConfigService,
  plan: PlanKey,
  mode: BillingMode,
) {
  return (
    config.get<string>(
      `BILLING_${plan.toUpperCase()}_${mode.toUpperCase()}_PRICE_ID`,
    ) ?? null
  );
}
