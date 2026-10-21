import { HttpException } from '@nestjs/common';
import type { PayrollInputsDto, PayrollAdjustmentDto } from './payroll.dto';
export const POLICY = 'ng-2026-monthly-v1';
export const MAX_MONEY = 999999999999999999n;
export function fail(code: string, status = 400, details?: unknown): never {
  throw new HttpException(
    { code, message: code, ...(details ? { details } : {}) },
    status,
  );
}
export function cents(v: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(v)) fail('INVALID_MONEY');
  const [a, b = ''] = v.split('.');
  return BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
}
export function money(v: bigint): string {
  if (v < 0n || v > MAX_MONEY) fail('AMOUNT_OUT_OF_RANGE');
  return `${v / 100n}.${String(v % 100n).padStart(2, '0')}`;
}
export function rounded(n: bigint, d: bigint) {
  return (n + d / 2n) / d;
}
export function date(v: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    fail('INVALID_DATE');
  return v;
}
export type Blocker = {
  code: string;
  message: string;
  employeeId: string | null;
  recipientId: string | null;
  field: string | null;
};
export type Totals = {
  baseAmount: string;
  allowancesAmount: string;
  grossAmount: string;
  deductionsAmount: string;
  netAmount: string;
  employerContributionsAmount: string;
  totalEmployerCost: string;
};
export type Source = {
  employee: {
    fullName: string;
    jobTitle: string | null;
    employeeTypeName: string | null;
    employmentStartDate: string | null;
    employmentEndDate: string | null;
    businessMemberId: string | null;
    avatar: string | null;
    status: string;
  };
  bank: {
    bankCode: string | null;
    bankName: string | null;
    accountNumber: string | null;
    accountName: string | null;
    verificationStatus: string;
    verifiedAt: string | null;
  };
  compensation: {
    amount: string | null;
    payFrequency: string;
    currency: string;
  };
  tax: null | {
    taxResidenceCountry: string;
    taxResidenceState: string | null;
    taxResidencyStatus: string | null;
    taxExemptionStatus: string | null;
    taxIdentificationNumber: string | null;
    pensionAccountNumber: string | null;
    pensionFundAdministrator: string | null;
    pensionContributionRate: string | null;
    employerPensionContributionRate: string | null;
    nhfApplicable: boolean | null;
    nhisApplicable: boolean | null;
    payrollInputs: PayrollInputsDto | null;
  };
};
export type Adjustment = PayrollAdjustmentDto & { id: string };
export type StatutoryLine = {
  code: string;
  label: string;
  kind: 'employee_deduction' | 'employer_contribution';
  amount: string;
  calculationReference: string;
};
export type Calculation = {
  totals: Totals | null;
  readiness: 'ready' | 'blocked';
  blockers: Blocker[];
  warnings: Blocker[];
  statutoryLines: StatutoryLine[];
  calculationVersion: string | null;
};
export function annualPaye(taxable: bigint) {
  const bands: [bigint | null, bigint][] = [
    [80000000n, 0n],
    [220000000n, 15n],
    [900000000n, 18n],
    [1300000000n, 21n],
    [2500000000n, 23n],
    [null, 25n],
  ];
  let remaining = taxable < 0n ? 0n : taxable,
    hundredths = 0n;
  for (const [width, rate] of bands) {
    const part = width === null || remaining < width ? remaining : width;
    hundredths += part * rate;
    remaining -= part;
    if (!remaining) break;
  }
  return rounded(hundredths, 100n);
}
export function calculate(
  s: Source,
  b: {
    periodStart: string;
    periodEnd: string;
    payFrequency: string;
    payDate?: string;
  },
  base: string | null,
  adjustments: Adjustment[],
  employeeId: string,
  recipientId: string | null,
): Calculation {
  const blockers: Blocker[] = [],
    warnings: Blocker[] = [];
  const issue = (code: string, field: string | null = null) => ({
    code,
    message: code,
    employeeId,
    recipientId,
    field,
  });
  const block = (code: string, field: string | null = null) =>
    blockers.push(issue(code, field));
  if (s.employee.status !== 'active') block('EMPLOYEE_INELIGIBLE', 'status');
  if (!s.employee.employmentStartDate)
    block('EMPLOYMENT_START_REQUIRED', 'employmentStartDate');
  else if (s.employee.employmentStartDate > b.periodStart)
    block('UNSUPPORTED_PRORATION', 'employmentStartDate');
  if (
    s.employee.employmentEndDate &&
    s.employee.employmentEndDate < b.periodEnd
  )
    block('UNSUPPORTED_PRORATION', 'employmentEndDate');
  if (s.compensation.amount === null) block('COMPENSATION_REQUIRED', 'amount');
  if (s.compensation.payFrequency !== b.payFrequency)
    block('FREQUENCY_MISMATCH', 'payFrequency');
  if (s.compensation.currency !== 'NGN')
    block('CURRENCY_UNSUPPORTED', 'currency');
  const monthEnd = new Date(
    Date.UTC(
      Number(b.periodStart.slice(0, 4)),
      Number(b.periodStart.slice(5, 7)),
      0,
    ),
  )
    .toISOString()
    .slice(0, 10);
  if (
    b.payFrequency !== 'monthly' ||
    !b.periodStart.endsWith('-01') ||
    b.periodEnd !== monthEnd
  )
    block('UNSUPPORTED_PAY_PERIOD');
  if (
    b.periodStart.slice(0, 4) !== '2026' ||
    b.periodEnd.slice(0, 4) !== '2026' ||
    (b.payDate !== undefined && b.payDate.slice(0, 4) !== '2026')
  )
    block('CALCULATION_POLICY_MISSING');
  if (
    !s.bank.bankCode?.trim() ||
    !s.bank.bankName?.trim() ||
    !s.bank.accountNumber ||
    !s.bank.accountName
  )
    block('BANK_DETAILS_REQUIRED', 'bank');
  if (['failed', 'stale'].includes(s.bank.verificationStatus))
    block('BANK_VERIFICATION_FAILED', 'bank');
  else if (s.bank.verificationStatus !== 'verified')
    warnings.push(issue('BANK_UNVERIFIED', 'bank'));
  const value = base ?? s.compensation.amount;
  const baseCents = value === null ? 0n : cents(value);
  const allowances = adjustments
    .filter((a) => a.kind === 'allowance')
    .reduce((n, a) => n + cents(a.amount), 0n);
  const customDeductions = adjustments
    .filter((a) => a.kind === 'deduction')
    .reduce((n, a) => n + cents(a.amount), 0n);
  const gross = baseCents + allowances;
  money(gross);
  money(customDeductions);
  if (customDeductions > gross) fail('NEGATIVE_NET_PAY');
  const t = s.tax,
    p = t?.payrollInputs;
  if (!t) block('TAX_PROFILE_REQUIRED', 'taxProfile');
  if (t && (!t.taxIdentificationNumber || !t.taxResidenceState))
    block('TAX_IDENTITY_REQUIRED', 'taxProfile');
  if (
    t &&
    (t.taxResidenceCountry !== 'NG' ||
      t.taxResidencyStatus !== 'resident' ||
      (t.taxExemptionStatus &&
        !['none', 'not_exempt'].includes(t.taxExemptionStatus)))
  )
    block('UNSUPPORTED_TAX_TREATMENT');
  if (
    !p ||
    p.policy !== POLICY ||
    p.employmentCategory !== 'resident_employee' ||
    p.taxYear !== 2026 ||
    p.regularMonthlyCashOnly !== true ||
    p.soleEmployment !== true ||
    p.claimsReviewed !== true
  )
    block('CALCULATION_INPUTS_REQUIRED', 'payrollInputs');
  // NHF applicability/base has changed across amendments; no guessed scheme deduction.
  if (t?.nhfApplicable === true)
    block('NHF_POLICY_UNSUPPORTED', 'nhfApplicable');
  if (t && (t.nhfApplicable === null || t.nhisApplicable === null))
    block('STATUTORY_APPLICABILITY_REQUIRED');
  let pension = 0n,
    employerPension = 0n,
    health = 0n,
    employerHealth = 0n,
    rentRelief = 0n,
    annualOther = 0n;
  if (p && p.policy === POLICY) {
    const pensionBase = cents(p.pensionableMonthlyAmount),
      basic = cents(p.basicMonthlyAmount),
      housing = cents(p.housingMonthlyAmount),
      transport = cents(p.transportMonthlyAmount);
    if (basic + housing + transport > gross || pensionBase > gross)
      block('INVALID_CONTRIBUTION_BASE');
    if (!p.pensionApplicabilityReason.trim())
      block('PENSION_APPLICABILITY_REQUIRED');
    if (p.pensionApplicable) {
      if (
        pensionBase < basic + housing + transport ||
        (!pensionBase && gross > 0n)
      )
        block('PENSION_BASE_REQUIRED');
      const rate = (v: string | null, min: bigint) => {
        if (!v) return min;
        const [a, f = ''] = v.split('.');
        const scaled = BigInt(a) * 10000n + BigInt(f.padEnd(4, '0'));
        if (scaled < min || scaled > 1000000n) block('PENSION_RATE_INVALID');
        return scaled;
      };
      pension = rounded(
        pensionBase * rate(t.pensionContributionRate, 80000n),
        1000000n,
      );
      employerPension = rounded(
        pensionBase * rate(t.employerPensionContributionRate, 100000n),
        1000000n,
      );
      if (!t?.pensionAccountNumber || !t.pensionFundAdministrator)
        block('PENSION_ACCOUNT_REQUIRED');
    } else if (
      pensionBase !== 0n ||
      (t?.pensionContributionRate && Number(t.pensionContributionRate) !== 0) ||
      (t?.employerPensionContributionRate &&
        Number(t.employerPensionContributionRate) !== 0)
    )
      block('PENSION_APPLICABILITY_CONFLICT');
    health = cents(p.nhisEmployeeMonthlyAmount);
    employerHealth = cents(p.nhisEmployerMonthlyAmount);
    if (!t?.nhisApplicable && (health || employerHealth))
      block('HEALTH_APPLICABILITY_CONFLICT');
    const rent = cents(p.annualRentPaid);
    rentRelief = rounded(rent, 5n);
    if (rentRelief > 50000000n) rentRelief = 50000000n;
    annualOther =
      cents(p.annualMortgageInterest) + cents(p.annualLifeInsurancePremium);
    if (
      (rent || annualOther || health || employerHealth) &&
      !p.evidenceReference.trim()
    )
      block('DEDUCTION_EVIDENCE_REQUIRED');
  }
  if (blockers.length)
    return {
      totals: null,
      readiness: 'blocked',
      blockers,
      warnings,
      statutoryLines: [],
      calculationVersion: null,
    };
  const chargeable =
    gross * 12n - (pension + health) * 12n - rentRelief - annualOther;
  const paye = gross <= 7000000n ? 0n : rounded(annualPaye(chargeable), 12n);
  const statutoryLines: StatutoryLine[] = [
    ['PAYE', 'PAYE', 'employee_deduction', paye],
    ['PENSION_EMPLOYEE', 'Employee pension', 'employee_deduction', pension],
    [
      'PENSION_EMPLOYER',
      'Employer pension',
      'employer_contribution',
      employerPension,
    ],
    ['NHF', 'NHF (not applicable)', 'employee_deduction', 0n],
    [
      'NHIS_EMPLOYEE',
      'Employee health contribution',
      'employee_deduction',
      health,
    ],
    [
      'NHIS_EMPLOYER',
      'Employer health contribution',
      'employer_contribution',
      employerHealth,
    ],
  ].map(([code, label, kind, amount]) => ({
    code: String(code),
    label: String(label),
    kind: kind as StatutoryLine['kind'],
    amount: money(amount as bigint),
    calculationReference: POLICY,
  }));
  const deductions = customDeductions + paye + pension + health,
    employer = employerPension + employerHealth;
  if (deductions > gross) fail('NEGATIVE_NET_PAY');
  if (deductions === gross) warnings.push(issue('ZERO_NET_NO_TRANSFER'));
  return {
    totals: {
      baseAmount: money(baseCents),
      allowancesAmount: money(allowances),
      grossAmount: money(gross),
      deductionsAmount: money(deductions),
      netAmount: money(gross - deductions),
      employerContributionsAmount: money(employer),
      totalEmployerCost: money(gross + employer),
    },
    readiness: 'ready',
    blockers,
    warnings,
    statutoryLines,
    calculationVersion: POLICY,
  };
}
export function sumTotals(values: Totals[]): Totals {
  return Object.fromEntries(
    Object.keys(values[0]).map((k) => [
      k,
      money(values.reduce((n, v) => n + cents(v[k as keyof Totals]), 0n)),
    ]),
  ) as Totals;
}
