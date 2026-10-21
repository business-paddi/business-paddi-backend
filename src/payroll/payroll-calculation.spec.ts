import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  annualPaye,
  calculate,
  cents,
  money,
  MAX_MONEY,
  date,
} from './payroll-calculation';
import type { Source, Adjustment } from './payroll-calculation';
import {
  PayrollCreateDto,
  PayrollRecipientPatchDto,
  PayrollInputsDto,
} from './payroll.dto';
export function validSource(): Source {
  return {
    employee: {
      fullName: 'Ada',
      jobTitle: null,
      employeeTypeName: null,
      employmentStartDate: '2026-01-01',
      employmentEndDate: null,
      businessMemberId: null,
      avatar: null,
      status: 'active',
    },
    bank: {
      bankCode: '058',
      bankName: 'Demo bank',
      accountNumber: 'encrypted',
      accountName: 'encrypted',
      verificationStatus: 'unverified',
      verifiedAt: null,
    },
    compensation: {
      amount: '300000.00',
      payFrequency: 'monthly',
      currency: 'NGN',
    },
    tax: {
      taxResidenceCountry: 'NG',
      taxResidenceState: 'Lagos',
      taxResidencyStatus: 'resident',
      taxExemptionStatus: 'none',
      taxIdentificationNumber: 'encrypted',
      pensionAccountNumber: null,
      pensionFundAdministrator: null,
      pensionContributionRate: null,
      employerPensionContributionRate: null,
      nhfApplicable: false,
      nhisApplicable: false,
      payrollInputs: {
        employmentCategory: 'resident_employee',
        policy: 'ng-2026-monthly-v1',
        taxYear: 2026,
        regularMonthlyCashOnly: true,
        soleEmployment: true,
        claimsReviewed: true,
        pensionApplicable: false,
        pensionableMonthlyAmount: '0.00',
        basicMonthlyAmount: '300000.00',
        housingMonthlyAmount: '0.00',
        transportMonthlyAmount: '0.00',
        annualRentPaid: '0.00',
        annualMortgageInterest: '0.00',
        annualLifeInsurancePremium: '0.00',
        nhisEmployeeMonthlyAmount: '0.00',
        nhisEmployerMonthlyAmount: '0.00',
        evidenceReference: '',
        pensionApplicabilityReason:
          'Outside compulsory scheme, documented employer assessment',
      },
    },
  };
}
const batch = {
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  payFrequency: 'monthly',
};
describe('Payroll statutory calculations and input contracts', () => {
  it.each([
    [800000, 0],
    [3000000, 330000],
    [12000000, 1950000],
    [25000000, 4680000],
    [50000000, 10430000],
    [51000000, 10680000],
  ])('applies progressive annual PAYE at %s', (income, tax) =>
    expect(annualPaye(BigInt(income) * 100n)).toBe(BigInt(tax) * 100n),
  );
  it('preserves exact decimals and rejects overflow and signed inputs', () => {
    expect(cents('9999999999999999.99')).toBe(MAX_MONEY);
    expect(money(cents('123.4'))).toBe('123.40');
    expect(() => cents('-1')).toThrow();
    expect(() => money(MAX_MONEY + 1n)).toThrow();
  });
  it('calculates monthly PAYE without inventing pension applicability', () => {
    const c = calculate(validSource(), batch, null, [], 'e', 'r');
    expect(c.totals?.netAmount).toBe('263500.00');
    expect(c.statutoryLines.find((l) => l.code === 'PAYE')?.amount).toBe(
      '36500.00',
    );
    expect(c.warnings.map((w) => w.code)).toContain('BANK_UNVERIFIED');
  });
  it('separates pension costs and applies documented rent relief', () => {
    const s = validSource();
    Object.assign(s.tax!, {
      pensionAccountNumber: 'encrypted',
      pensionFundAdministrator: 'PFA',
    });
    Object.assign(s.tax!.payrollInputs!, {
      pensionApplicable: true,
      pensionableMonthlyAmount: '180000.00',
      basicMonthlyAmount: '100000.00',
      housingMonthlyAmount: '50000.00',
      transportMonthlyAmount: '30000.00',
      annualRentPaid: '2000000.00',
      evidenceReference: 'reviewed-rent-receipt',
    });
    const c = calculate(s, batch, null, [], 'e', 'r');
    expect(c.totals?.netAmount).toBe('257692.00');
    expect(c.totals?.employerContributionsAmount).toBe('18000.00');
  });
  it('does not turn missing compensation or tax inputs into a zero calculation', () => {
    const s = validSource();
    s.compensation.amount = null;
    s.tax = null;
    const c = calculate(s, batch, '0.00', [], 'e', 'r');
    expect(c.totals).toBeNull();
    expect(c.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['COMPENSATION_REQUIRED', 'TAX_PROFILE_REQUIRED']),
    );
  });
  it('supports explicit zero and minimum wage exemption without fabricating bank verification', () => {
    const s = validSource();
    s.compensation.amount = '0.00';
    s.tax!.payrollInputs!.basicMonthlyAmount = '0.00';
    expect(calculate(s, batch, null, [], 'e', 'r').totals?.netAmount).toBe(
      '0.00',
    );
    s.compensation.amount = '70000.00';
    expect(
      calculate(s, batch, null, [], 'e', 'r').statutoryLines.find(
        (l) => l.code === 'PAYE',
      )?.amount,
    ).toBe('0.00');
  });
  it('blocks partial periods, nonresident, schemes without supported policy, and absent evidence', () => {
    const s = validSource();
    s.tax!.nhfApplicable = true;
    s.tax!.payrollInputs!.annualRentPaid = '1000000.00';
    s.tax!.taxResidencyStatus = 'nonresident';
    const c = calculate(
      s,
      { ...batch, periodStart: '2026-10-02' },
      null,
      [],
      'e',
      'r',
    );
    expect(c.totals).toBeNull();
    expect(c.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([
        'UNSUPPORTED_PAY_PERIOD',
        'UNSUPPORTED_TAX_TREATMENT',
        'NHF_POLICY_UNSUPPORTED',
        'DEDUCTION_EVIDENCE_REQUIRED',
      ]),
    );
  });
  it('custom deductions do not reduce PAYE and negative net is rejected', () => {
    const adjustment: Adjustment = {
      id: 'a',
      clientId: 'client',
      kind: 'deduction',
      label: 'Loan',
      reason: 'Repayment',
      amount: '1000.00',
    };
    const c = calculate(validSource(), batch, null, [adjustment], 'e', 'r');
    expect(c.statutoryLines.find((l) => l.code === 'PAYE')?.amount).toBe(
      '36500.00',
    );
    expect(c.totals?.netAmount).toBe('262500.00');
    expect(() =>
      calculate(
        validSource(),
        batch,
        null,
        [{ ...adjustment, amount: '999999.00' }],
        'e',
        'r',
      ),
    ).toThrow();
  });
  it('rejects impossible calendar dates', () => {
    expect(() => date('2026-02-30')).toThrow();
    expect(date('2026-02-28')).toBe('2026-02-28');
  });
  it('validates explicit statutory inputs and rejects null/duplicates/foreign actor fields', async () => {
    expect(
      await validate(
        plainToInstance(PayrollInputsDto, validSource().tax!.payrollInputs),
        { whitelist: true, forbidNonWhitelisted: true },
      ),
    ).toHaveLength(0);
    const create = {
      name: 'October',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payDate: '2026-10-31',
      payFrequency: 'monthly',
      currency: 'NGN',
      employeeIds: ['e', 'e'],
      createdBy: 'attacker',
    };
    expect(
      (
        await validate(plainToInstance(PayrollCreateDto, create), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(PayrollRecipientPatchDto, {
            expectedRevision: 1,
            baseAmount: null,
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
