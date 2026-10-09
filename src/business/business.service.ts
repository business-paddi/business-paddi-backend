import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService, ROLE_INCLUDE } from './business-access.service';
import {
  BusinessDto,
  UpdateBusinessDto,
  OnboardDto,
  EmployeeTypeDto,
  GroupDto,
} from './business.dto';
import { seedEmployeeTypes } from '../business-foundation/seed';
import { roleResponse, employeeResponse } from './business.responses';
import { InviteService } from './invite.service';
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { EmployeeService } from './employee.service';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class BusinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly invites: InviteService,
    private readonly employees: EmployeeService,
  ) {}

  create(userId: string, input: BusinessDto, key?: string) {
    return this.onboard(userId, { business: input }, key);
  }

  async onboard(userId: string, input: OnboardDto, key?: string) {
    if (key !== undefined && !/^[A-Za-z0-9_-]{16,80}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key must contain 16 to 80 letters, digits, underscores or hyphens',
      );
    const requestHash = createHash('sha256')
      .update(JSON.stringify(canonical(input)))
      .digest('hex');
    const employees = input.employees ?? [];
    if (new Set(employees.map((e) => e.email)).size !== employees.length)
      throw new ConflictException('Duplicate employee email in onboarding');
    const result = await this.prisma.$transaction(
      async (db) => {
        if (key) {
          await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':' + key}, 0))::text`;
          const previous = await db.businessCreationRequest.findUnique({
            where: { userId_key: { userId, key } },
          });
          if (previous) {
            if (previous.requestHash !== requestHash)
              throw new ConflictException(
                'Idempotency-Key was used with a different request',
              );
            await this.access.require(userId, previous.businessId, [], db);
            return { replay: previous.result };
          }
        }
        const owner = await db.role.findFirst({
          where: {
            key: 'owner',
            type: 'system',
            businessId: null,
            status: 'active',
          },
        });
        if (!owner)
          throw new ServiceUnavailableException('System roles are not seeded');
        const business = await db.business.create({ data: input.business });
        const membership = await db.businessMember.create({
          data: { businessId: business.id, userId, roleId: owner.id },
          include: { role: { include: ROLE_INCLUDE } },
        });
        await seedEmployeeTypes(db, business.id);
        const types = await db.employeeType.findMany({
          where: { businessId: business.id, status: 'active' },
        });
        const registered = [] as Awaited<
          ReturnType<typeof db.businessEmployee.create>
        >[];
        const deliveries = [] as Awaited<ReturnType<InviteService['record']>>[];
        for (const employee of employees) {
          const type = types.find((t) => t.key === employee.employeeTypeKey);
          if (!type) throw new BadRequestException('Invalid employee type');
          const {
            employeeTypeKey: _key,
            connectToPlatform,
            ...details
          } = employee;
          void _key;
          const row = await this.employees.register(db, business.id, {
            ...details,
            employeeTypeId: type.id,
          });
          registered.push(row);
          if (connectToPlatform)
            deliveries.push(
              await this.invites.record(db, userId, business.id, {
                email: employee.email,
                employeeId: row.id,
              }),
            );
        }
        const response = {
          business,
          membership: { ...membership, role: roleResponse(membership.role) },
          employeeTypes: types,
          employees: registered.map((e) => employeeResponse(e, true)),
          invitations: deliveries.map((d) => ({
            ...d.invite,
            tokenHash: undefined,
          })),
        };
        if (key)
          await db.businessCreationRequest.create({
            data: {
              userId,
              key,
              requestHash,
              businessId: business.id,
              result: json(response),
            },
          });
        return { response, deliveries };
      },
      { maxWait: 15000, timeout: 120000 },
    );
    if ('replay' in result) return result.replay;
    const invitations = [] as Awaited<ReturnType<InviteService['deliver']>>[];
    for (const delivery of result.deliveries)
      invitations.push(await this.invites.deliver(delivery));
    // Replays deliberately retain the committed snapshot with delivery=pending;
    // GET invites is the authoritative delivery/lifecycle state after email dispatch.
    return { ...result.response, invitations };
  }

  async list(userId: string) {
    const memberships = await this.prisma.businessMember.findMany({
      where: { userId, status: 'active', role: { status: 'active' } },
      include: { business: true, role: { include: ROLE_INCLUDE } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      items: memberships
        .filter(
          (m) => m.role.type === 'system' || m.role.businessId === m.businessId,
        )
        .map((m) => {
          const { business, role, ...membership } = m;
          return {
            business,
            membership: { ...membership, role: roleResponse(role) },
          };
        }),
    };
  }

  async get(userId: string, businessId: string) {
    const { member } = await this.access.require(userId, businessId);
    const { business, role, ...membership } = member;
    return {
      business,
      membership: { ...membership, role: roleResponse(role) },
    };
  }

  update(userId: string, businessId: string, input: UpdateBusinessDto) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['business:update'], db);
      return {
        business: await db.business.update({
          where: { id: businessId },
          data: input,
        }),
      };
    });
  }

  async summary(userId: string, businessId: string) {
    await this.access.require(userId, businessId, [
      'employees:view',
      'members:view',
    ]);
    const [
      totalEmployees,
      activeEmployees,
      pendingInvitations,
      taxProfiles,
      missingCompensation,
      missingBankDetails,
    ] = await this.prisma.$transaction([
      this.prisma.businessEmployee.count({
        where: { businessId, status: { not: 'archived' } },
      }),
      this.prisma.businessEmployee.count({
        where: { businessId, status: 'active' },
      }),
      this.prisma.businessInvite.count({
        where: { businessId, status: 'pending', expiresAt: { gt: new Date() } },
      }),
      this.prisma.employeeTaxProfile.count({
        where: { businessId, employee: { status: { not: 'archived' } } },
      }),
      this.prisma.businessEmployee.count({
        where: { businessId, status: { not: 'archived' }, amount: null },
      }),
      this.prisma.businessEmployee.count({
        where: {
          businessId,
          status: { not: 'archived' },
          OR: [{ bankCode: null }, { accountNumber: null }],
        },
      }),
    ]);
    return {
      totalEmployees,
      activeEmployees,
      pendingInvitations,
      taxSetup: {
        configuredProfiles: taxProfiles,
        profilesNotConfigured: totalEmployees - taxProfiles,
        complianceStatus: 'unavailable',
      },
      onboardingTasks: { missingCompensation, missingBankDetails },
      taxLiability: null,
    };
  }

  async types(userId: string, businessId: string) {
    await this.access.require(userId, businessId, ['employee_lists:view']);
    return {
      items: await this.prisma.employeeType.findMany({
        where: { businessId, status: 'active' },
        orderBy: { name: 'asc' },
      }),
    };
  }
  createType(userId: string, businessId: string, input: EmployeeTypeDto) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['employees:create'], db);
      return {
        employeeType: await db.employeeType.create({
          data: { ...input, businessId },
        }),
      };
    });
  }
  async groups(userId: string, businessId: string) {
    await this.access.require(userId, businessId, ['employee_lists:view']);
    return {
      items: await this.prisma.employeeGroup.findMany({
        where: { businessId, status: 'active' },
        orderBy: { name: 'asc' },
      }),
    };
  }
  createGroup(userId: string, businessId: string, input: GroupDto) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['employee_lists:create'], db);
      return {
        group: await db.employeeGroup.create({
          data: { ...input, businessId },
        }),
      };
    });
  }
  async members(userId: string, businessId: string) {
    await this.access.require(userId, businessId, ['members:view']);
    const members = await this.prisma.businessMember.findMany({
      where: { businessId },
      include: {
        role: { include: ROLE_INCLUDE },
        user: { select: { id: true, name: true, avatar: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: members.map((m) => ({ ...m, role: roleResponse(m.role) })),
    };
  }
  async roles(userId: string, businessId: string, roleId?: string) {
    await this.access.require(userId, businessId, ['roles:view']);
    const roles = await this.prisma.role.findMany({
      where: {
        ...(roleId ? { id: roleId } : {}),
        OR: [
          { type: 'system', businessId: null },
          { type: 'custom', businessId },
        ],
      },
      include: ROLE_INCLUDE,
      orderBy: { name: 'asc' },
    });
    if (roleId && !roles.length) throw new NotFoundException('Role not found');
    const counts = await this.prisma.businessMember.groupBy({
      by: ['roleId'],
      where: { businessId, status: 'active' },
      _count: true,
    });
    const items = roles.map((r) =>
      roleResponse(r, counts.find((c) => c.roleId === r.id)?._count ?? 0),
    );
    return roleId ? { role: items[0] } : { items };
  }
}
