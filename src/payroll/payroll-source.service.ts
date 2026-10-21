import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import { decryptPayrollField } from '../business-foundation/sensitive-fields';
import { PrismaService } from '../database/prisma.service';
import type { Source } from './payroll-calculation';
import { fail } from './payroll-calculation';
import type { PayrollInputsDto } from './payroll.dto';
import { digest } from '../tasks/task.utils';
export const EMPLOYEE_SOURCE_INCLUDE = {
  employeeType: true,
  taxProfile: true,
  businessMember: { include: { user: { select: { avatar: true } } } },
  groups: { include: { group: true } },
} as const;
@Injectable()
export class PayrollSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  decode(v: string | null) {
    if (!v) return null;
    try {
      return decryptPayrollField(
        v,
        this.config.getOrThrow<string>('PAYROLL_ENCRYPTION_KEY'),
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_ENCRYPTION_UNAVAILABLE',
        message: 'Payroll encryption unavailable',
      });
    }
  }
  async read(
    businessId: string,
    employeeId: string,
    db: Prisma.TransactionClient = this.prisma,
    lock = false,
  ) {
    if (lock) {
      await db.$queryRaw`SELECT "id" FROM "BusinessEmployee" WHERE "businessId"=${businessId} AND "id"=${employeeId} FOR UPDATE`;
      await db.$queryRaw`SELECT "id" FROM "EmployeeTaxProfile" WHERE "businessId"=${businessId} AND "employeeId"=${employeeId} FOR SHARE`;
    }
    const e = await db.businessEmployee.findUnique({
      where: { businessId_id: { businessId, id: employeeId } },
      include: EMPLOYEE_SOURCE_INCLUDE,
    });
    if (!e) fail('EMPLOYEE_NOT_FOUND', 404);
    return this.present(e);
  }
  async many(
    businessId: string,
    employeeIds: string[],
    db: Prisma.TransactionClient = this.prisma,
    lock = false,
  ) {
    const ids = [...new Set(employeeIds)].sort();
    if (!ids.length)
      return new Map<string, ReturnType<PayrollSourceService['present']>>();
    if (lock) {
      await db.$queryRaw(
        Prisma.sql`SELECT "id" FROM "BusinessEmployee" WHERE "businessId"=${businessId} AND "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`,
      );
      await db.$queryRaw(
        Prisma.sql`SELECT "id" FROM "EmployeeTaxProfile" WHERE "businessId"=${businessId} AND "employeeId" IN (${Prisma.join(ids)}) ORDER BY "employeeId" FOR SHARE`,
      );
    }
    const employees = await db.businessEmployee.findMany({
      where: { businessId, id: { in: ids } },
      include: EMPLOYEE_SOURCE_INCLUDE,
    });
    return new Map(employees.map((e) => [e.id, this.present(e)]));
  }
  private present(
    e: Prisma.BusinessEmployeeGetPayload<{
      include: typeof EMPLOYEE_SOURCE_INCLUDE;
    }>,
  ) {
    const tax = e.taxProfile;
    const source: Source = {
      employee: {
        fullName: e.fullName,
        jobTitle: e.jobTitle,
        employeeTypeName: e.employeeType?.name ?? null,
        employmentStartDate:
          tax?.employmentStartDate?.toISOString().slice(0, 10) ?? null,
        employmentEndDate:
          tax?.employmentEndDate?.toISOString().slice(0, 10) ?? null,
        businessMemberId: e.businessMemberId,
        avatar: e.businessMember?.user.avatar ?? null,
        status: e.status,
      },
      bank: {
        bankCode: e.bankCode,
        bankName: e.bankName,
        accountNumber: e.accountNumber,
        accountName: e.accountName,
        verificationStatus: e.accountVerificationStatus,
        verifiedAt: e.accountVerifiedAt?.toISOString() ?? null,
      },
      compensation: {
        amount: e.amount?.toFixed(2) ?? null,
        payFrequency:
          e.payFrequency === 'bi_weekly' ? 'bi-weekly' : e.payFrequency,
        currency: e.currency,
      },
      tax: tax
        ? {
            taxResidenceCountry: tax.taxResidenceCountry,
            taxResidenceState: tax.taxResidenceState,
            taxResidencyStatus: tax.taxResidencyStatus,
            taxExemptionStatus: tax.taxExemptionStatus,
            taxIdentificationNumber: tax.taxIdentificationNumber,
            pensionAccountNumber: tax.pensionAccountNumber,
            pensionFundAdministrator: tax.pensionFundAdministrator,
            pensionContributionRate:
              tax.pensionContributionRate?.toFixed(4) ?? null,
            employerPensionContributionRate:
              tax.employerPensionContributionRate?.toFixed(4) ?? null,
            nhfApplicable: tax.nhfApplicable,
            nhisApplicable: tax.nhisApplicable,
            payrollInputs: (tax.payrollInputs ??
              null) as unknown as PayrollInputsDto | null,
          }
        : null,
    };
    // Validate encrypted banking setup without persisting plaintext in snapshots.
    if (
      source.bank.accountNumber &&
      !/^\d{10}$/.test(this.decode(source.bank.accountNumber)!)
    )
      source.bank.accountNumber = null;
    if (
      source.bank.accountName &&
      !this.decode(source.bank.accountName)?.trim()
    )
      source.bank.accountName = null;
    return {
      source,
      version: digest(source),
      groups: e.groups.map((g) => ({ id: g.groupId, name: g.group.name })),
    };
  }
  bank(s: Source) {
    const number = this.decode(s.bank.accountNumber);
    return {
      bankCode: s.bank.bankCode,
      bankName: s.bank.bankName,
      maskedAccountNumber: number ? `******${number.slice(-4)}` : null,
      accountName: this.decode(s.bank.accountName),
      verificationStatus: s.bank.verificationStatus,
      verifiedAt: s.bank.verifiedAt,
    };
  }
}
