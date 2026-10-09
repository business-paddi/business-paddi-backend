import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import type { Prisma, BusinessEmployee } from '../../generated/prisma/client';
import { BusinessAccessService } from './business-access.service';
import {
  EmployeeDto,
  EmployeeQueryDto,
  UpdateEmployeeDto,
  TaxProfileDto,
} from './business.dto';
import { EMPLOYEE_INCLUDE, employeeResponse } from './business.responses';
import {
  decryptPayrollField,
  encryptPayrollField,
} from '../business-foundation/sensitive-fields';

@Injectable()
export class EmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly config: ConfigService,
  ) {}

  private async find(
    db: Prisma.TransactionClient,
    businessId: string,
    employeeId: string,
  ) {
    const employee = await db.businessEmployee.findUnique({
      where: { businessId_id: { businessId, id: employeeId } },
      include: EMPLOYEE_INCLUDE,
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }
  private key() {
    const key = this.config.get<string>('PAYROLL_ENCRYPTION_KEY');
    if (
      !key ||
      Buffer.from(key, 'base64').length !== 32 ||
      Buffer.from(key, 'base64').toString('base64') !== key
    )
      throw new ServiceUnavailableException(
        'Sensitive field encryption is not configured',
      );
    return key;
  }
  private encode(value: string | null) {
    return value === null ? null : encryptPayrollField(value, this.key());
  }
  private decode(value: string | null) {
    return value === null ? null : decryptPayrollField(value, this.key());
  }

  async create(userId: string, businessId: string, input: EmployeeDto) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['employees:create'], db);
      return {
        employee: employeeResponse(
          await this.register(db, businessId, input),
          true,
        ),
      };
    });
  }

  async register(
    db: Prisma.TransactionClient,
    businessId: string,
    input: EmployeeDto,
  ) {
    await this.validType(db, businessId, input.employeeTypeId);
    const { fullName, email, state, employeeTypeId, ...options } = input;
    const employee = await db.businessEmployee.create({
      include: EMPLOYEE_INCLUDE,
      data: {
        fullName,
        email,
        state,
        employeeTypeId,
        businessId,
        paymentBlockedReason: 'missing_compensation_and_bank_details',
      },
    });
    return Object.values(options).some((value) => value !== undefined)
      ? this.updateRecord(db, businessId, employee.id, options)
      : employee;
  }
  private async validType(
    db: Prisma.TransactionClient,
    businessId: string,
    id: string,
  ) {
    const type = await db.employeeType.findFirst({
      where: { id, businessId, status: 'active' },
    });
    if (!type)
      throw new BadRequestException(
        'Employee type must be active in this business',
      );
  }
  async list(userId: string, businessId: string, query: EmployeeQueryDto) {
    await this.access.require(userId, businessId, ['employees:view']);
    const where: Prisma.BusinessEmployeeWhereInput = {
      businessId,
      status: query.status ?? { not: 'archived' },
      ...(query.employeeTypeId ? { employeeTypeId: query.employeeTypeId } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.businessEmployee.findMany({
        include: EMPLOYEE_INCLUDE,
        where,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.businessEmployee.count({ where }),
    ]);
    return {
      items: items.map((e) => employeeResponse(e)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }
  async get(userId: string, businessId: string, employeeId: string) {
    const access = await this.access.require(userId, businessId);
    const employee = await this.find(this.prisma, businessId, employeeId);
    if (
      !access.permissions.includes('employees:view') &&
      !(
        access.permissions.includes('employees:view_own') &&
        employee.businessMemberId === access.member.id
      )
    )
      throw new ForbiddenException('Missing business permission');
    const financial = access.permissions.includes('employees:update');
    const groups = await this.prisma.businessEmployeeGroup.findMany({
      where: { businessId, employeeId },
      select: { groupId: true },
    });
    return {
      employee: {
        ...employeeResponse(employee, financial),
        groupIds: groups.map((g) => g.groupId),
        ...(financial
          ? {
              bankCode: employee.bankCode,
              bankName: employee.bankName,
              accountNumber: this.decode(employee.accountNumber),
              accountName: this.decode(employee.accountName),
            }
          : {}),
      },
    };
  }
  async update(
    userId: string,
    businessId: string,
    employeeId: string,
    input: UpdateEmployeeDto,
  ) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['employees:update'], db);
      return {
        employee: employeeResponse(
          await this.updateRecord(db, businessId, employeeId, input),
          true,
        ),
      };
    });
  }

  private async updateRecord(
    db: Prisma.TransactionClient,
    businessId: string,
    employeeId: string,
    input: UpdateEmployeeDto,
  ) {
    await db.$queryRaw`SELECT "id" FROM "BusinessEmployee" WHERE "businessId" = ${businessId} AND "id" = ${employeeId} FOR UPDATE`;
    const old = await this.find(db, businessId, employeeId);
    if (old.status === 'archived')
      throw new BadRequestException('Archived employees cannot be updated');
    if (input.employeeTypeId !== undefined)
      await this.validType(db, businessId, input.employeeTypeId);
    if (input.managerEmployeeId) {
      if (input.managerEmployeeId === employeeId)
        throw new BadRequestException('Employee cannot manage themselves');
      const manager = await this.find(db, businessId, input.managerEmployeeId);
      if (manager.status === 'archived')
        throw new BadRequestException('Manager is archived');
    }
    if (input.groupIds?.length) {
      const count = await db.employeeGroup.count({
        where: { businessId, id: { in: input.groupIds }, status: 'active' },
      });
      if (count !== input.groupIds.length)
        throw new BadRequestException('Groups must be active in this business');
    }
    const { groupIds, accountNumber, accountName, payFrequency, ...fields } =
      input;
    const data: Prisma.BusinessEmployeeUncheckedUpdateInput = {
      ...fields,
      ...(payFrequency !== undefined
        ? {
            payFrequency:
              payFrequency === 'bi-weekly'
                ? 'bi_weekly'
                : (payFrequency as BusinessEmployee['payFrequency']),
          }
        : {}),
      ...(accountNumber !== undefined
        ? { accountNumber: this.encode(accountNumber) }
        : {}),
      ...(accountName !== undefined
        ? { accountName: this.encode(accountName) }
        : {}),
      // Eligibility is managed by a future verification workflow, never by this endpoint.
      paymentStatus: 'blocked',
      paymentBlockedReason: 'payment_setup_requires_verification',
    };
    // Avoid invalidating verification when the client re-sends the same account number.
    if (
      accountNumber !== undefined &&
      accountNumber === this.decode(old.accountNumber)
    )
      delete data.accountNumber;
    const employee = await db.businessEmployee.update({
      include: EMPLOYEE_INCLUDE,
      where: { businessId_id: { businessId, id: employeeId } },
      data,
    });
    if (groupIds !== undefined) {
      await db.businessEmployeeGroup.deleteMany({
        where: { businessId, employeeId },
      });
      await db.businessEmployeeGroup.createMany({
        data: groupIds.map((groupId) => ({
          businessId,
          employeeId,
          groupId,
        })),
      });
    }
    return employee;
  }
  archive(userId: string, businessId: string, employeeId: string) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['employees:archive'], db);
      await this.find(db, businessId, employeeId);
      const employee = await db.businessEmployee.update({
        include: EMPLOYEE_INCLUDE,
        where: { businessId_id: { businessId, id: employeeId } },
        data: {
          status: 'archived',
          paymentStatus: 'blocked',
          paymentBlockedReason: 'employee_archived',
        },
      });
      return { employee: employeeResponse(employee, true) };
    });
  }
  private taxResponse(
    profile: Awaited<
      ReturnType<Prisma.TransactionClient['employeeTaxProfile']['findUnique']>
    >,
  ) {
    if (!profile) return null;
    return {
      ...profile,
      taxIdentificationNumber: this.decode(profile.taxIdentificationNumber),
      pensionAccountNumber: this.decode(profile.pensionAccountNumber),
      employmentStartDate:
        profile.employmentStartDate?.toISOString().slice(0, 10) ?? null,
      employmentEndDate:
        profile.employmentEndDate?.toISOString().slice(0, 10) ?? null,
      pensionContributionRate:
        profile.pensionContributionRate?.toFixed(4) ?? null,
      employerPensionContributionRate:
        profile.employerPensionContributionRate?.toFixed(4) ?? null,
    };
  }
  async tax(userId: string, businessId: string, employeeId: string) {
    await this.access.require(userId, businessId, [
      'employees:view',
      'employees:update',
    ]);
    await this.find(this.prisma, businessId, employeeId);
    return {
      taxProfile: this.taxResponse(
        await this.prisma.employeeTaxProfile.findUnique({
          where: { businessId_employeeId: { businessId, employeeId } },
        }),
      ),
    };
  }
  putTax(
    userId: string,
    businessId: string,
    employeeId: string,
    input: TaxProfileDto,
  ) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(
        userId,
        businessId,
        ['employees:view', 'employees:update'],
        db,
      );
      await db.$queryRaw`SELECT "id" FROM "BusinessEmployee" WHERE "businessId" = ${businessId} AND "id" = ${employeeId} FOR UPDATE`;
      const employee = await this.find(db, businessId, employeeId);
      if (employee.status === 'archived')
        throw new BadRequestException('Archived employees cannot be updated');
      const old = await db.employeeTaxProfile.findUnique({
        where: { businessId_employeeId: { businessId, employeeId } },
      });
      const {
        taxIdentificationNumber,
        pensionAccountNumber,
        employmentStartDate,
        employmentEndDate,
        ...plain
      } = input;
      const start =
        employmentStartDate === undefined
          ? old?.employmentStartDate
          : employmentStartDate === null
            ? null
            : new Date(employmentStartDate);
      const end =
        employmentEndDate === undefined
          ? old?.employmentEndDate
          : employmentEndDate === null
            ? null
            : new Date(employmentEndDate);
      if (start && end && end < start)
        throw new BadRequestException(
          'Employment end date must not precede start date',
        );
      const data = {
        ...plain,
        ...(taxIdentificationNumber !== undefined
          ? { taxIdentificationNumber: this.encode(taxIdentificationNumber) }
          : {}),
        ...(pensionAccountNumber !== undefined
          ? { pensionAccountNumber: this.encode(pensionAccountNumber) }
          : {}),
        ...(employmentStartDate !== undefined
          ? { employmentStartDate: start }
          : {}),
        ...(employmentEndDate !== undefined ? { employmentEndDate: end } : {}),
      };
      const profile = await db.employeeTaxProfile.upsert({
        where: { businessId_employeeId: { businessId, employeeId } },
        create: { ...data, businessId, employeeId },
        update: data,
      });
      return { taxProfile: this.taxResponse(profile) };
    });
  }
}
