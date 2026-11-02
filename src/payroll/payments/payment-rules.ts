import { createHash } from 'node:crypto';
import { cents, fail, money } from '../payroll-calculation';
import type { PaymentSnapshot } from './payment-provider';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}
// JSONB does not retain object-key order; hashes must survive a database round-trip.
export const digestPayment = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export const nairaToKobo = (value: string) => {
  const result = cents(value);
  if (result > 999999999999999999n) fail('AMOUNT_OUT_OF_RANGE');
  return result;
};
export const koboToNaira = (value: string) => money(BigInt(value));

export function validateSnapshot(snapshot: PaymentSnapshot) {
  if (
    snapshot.currency !== 'NGN' ||
    !snapshot.beneficiaries.length ||
    snapshot.beneficiaries.length > 251
  )
    fail('INVALID_PAYMENT_SNAPSHOT');
  const ids = new Set<string>(),
    accounts = new Set<string>(),
    employees = new Set<string>();
  let salary = 0n,
    fee = 0n,
    feeCount = 0;
  for (const b of snapshot.beneficiaries) {
    if (
      !b.lineItemId ||
      ids.has(b.lineItemId) ||
      !b.name.trim() ||
      !/^\d{3,6}$/.test(b.bankCode) ||
      !/^\d{10}$/.test(b.account)
    )
      fail('INVALID_BENEFICIARY');
    ids.add(b.lineItemId);
    const account = `${b.bankCode}:${b.account}`;
    if (accounts.has(account)) fail('DUPLICATE_BENEFICIARY');
    accounts.add(account);
    if (!/^[1-9]\d{0,17}$/.test(b.amountKobo)) fail('INVALID_PAYMENT_AMOUNT');
    if (b.recipientType === 'EMPLOYEE') {
      if (!b.employeeId || employees.has(b.employeeId))
        fail('DUPLICATE_EMPLOYEE');
      employees.add(b.employeeId);
      salary += BigInt(b.amountKobo);
    } else if (b.recipientType === 'PLATFORM_FEE' && b.employeeId === null) {
      fee += BigInt(b.amountKobo);
      feeCount++;
    } else fail('INVALID_RECIPIENT_TYPE');
  }
  if (
    feeCount !== 1 ||
    salary <= 0n ||
    salary.toString() !== snapshot.totalNetSalaryKobo ||
    fee.toString() !== snapshot.platformFeeKobo ||
    (salary + fee).toString() !== snapshot.totalInvoiceKobo ||
    salary + fee > 999999999999999999n
  )
    fail('PAYMENT_TOTAL_MISMATCH');
}
