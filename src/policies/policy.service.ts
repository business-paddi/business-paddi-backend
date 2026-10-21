import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { BusinessAccessService } from '../business/business-access.service';
import { PrismaService } from '../database/prisma.service';
import { CreatePolicyClassesDto, PolicyDraftDto } from './policy.dto';
import {
  nameKey,
  parseClassNames,
  parsePolicy,
  validateClassNames,
} from './policy-parser';

// Match the budget used by the other business mutations against hosted Postgres.
// Class batches perform authorization, inserts, and audit writes atomically.
export const POLICY_TRANSACTION_OPTIONS = { maxWait: 15000, timeout: 30000 };

@Injectable()
export class PolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
  ) {}

  private audit(
    db: Prisma.TransactionClient,
    userId: string,
    businessId: string,
    event: string,
    metadata: Prisma.InputJsonObject,
  ) {
    return db.auditEvent.create({
      data: {
        eventId: randomUUID(),
        businessId,
        userId,
        category: 'business',
        outcome: 'success',
        eventType: `business.policy.${event}`,
        metadata,
      },
    });
  }

  async setup(userId: string, businessId: string) {
    await this.access.require(userId, businessId, ['policies:view']);
    const [classes, groups] = await Promise.all([
      this.prisma.policyClass.findMany({
        where: { businessId },
        orderBy: { name: 'asc' },
      }),
      this.prisma.employeeGroup.findMany({
        where: { businessId, status: 'active' },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      message: classes.length
        ? 'Let’s get your first policy started.'
        : 'First, create classes to organize your policies.',
      help: {
        classes:
          'Classes are labels for grouping policies, such as Holiday, Vacation, Work grants, Restrictions or Documents. Create the names that make sense for your business.',
        classExample: 'Create classes Holiday and Vacation',
        policyExample:
          'Create a Vacation policy for employees in Engineering for one week during December from 18th to 25th December 2026',
        dates:
          'Start and end dates include both days. Duration is an optional allowance within that window.',
        limitations:
          'This version records time-bound policies and employee assignments. It does not approve leave, allocate equipment, enforce access, or understand additional restrictions.',
      },
      classes,
      groups,
    };
  }

  async createClasses(
    userId: string,
    businessId: string,
    input: CreatePolicyClassesDto,
  ) {
    // Check authorization before returning parser feedback.
    await this.access.require(userId, businessId, ['policies:create']);
    if (Boolean(input.text) === Boolean(input.names))
      throw new BadRequestException('Provide either text or names.');
    let names: string[];
    try {
      names = input.names
        ? validateClassNames(input.names)
        : parseClassNames(input.text!);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return this.prisma.$transaction(async (db) => {
      // Serialize class creation for case-insensitive idempotence and one audit per new class.
      await db.$queryRaw`SELECT "id" FROM "Business" WHERE "id" = ${businessId} FOR UPDATE`;
      await this.access.lock(userId, businessId, ['policies:create'], db);
      const classes: Awaited<ReturnType<typeof db.policyClass.create>>[] = [];
      let createdCount = 0;
      for (const name of names) {
        const key = nameKey(name);
        const existing = await db.policyClass.findUnique({
          where: { businessId_key: { businessId, key } },
        });
        if (existing) {
          classes.push(existing);
          continue;
        }
        const item = await db.policyClass.create({
          data: { businessId, name, key, createdByUserId: userId },
        });
        await this.audit(db, userId, businessId, 'class_created', {
          classId: item.id,
          name,
        });
        classes.push(item);
        createdCount++;
      }
      return {
        success: true,
        message: 'Your classes are ready! Let’s get your first policy started.',
        classes,
        createdCount,
      };
    }, POLICY_TRANSACTION_OPTIONS);
  }

  private async resolve(
    db: Prisma.TransactionClient,
    businessId: string,
    input: PolicyDraftDto,
  ) {
    const [classes, groups] = await Promise.all([
      db.policyClass.findMany({
        where: { businessId },
        select: { id: true, name: true },
      }),
      db.employeeGroup.findMany({
        where: { businessId, status: 'active' },
        select: { id: true, name: true },
      }),
    ]);
    const result = parsePolicy(input, classes, groups);
    const eligibleEmployeeCount = result.draft.groupId
      ? await db.businessEmployee.count({
          where: {
            businessId,
            status: 'active',
            groups: { some: { groupId: result.draft.groupId } },
          },
        })
      : 0;
    return {
      ...result,
      eligibleEmployeeCount,
      assignmentMode: 'explicit' as const,
    };
  }

  async preview(userId: string, businessId: string, input: PolicyDraftDto) {
    await this.access.require(userId, businessId, ['policies:create']);
    return this.resolve(this.prisma, businessId, input);
  }

  async create(userId: string, businessId: string, input: PolicyDraftDto) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['policies:create'], db);
      const result = await this.resolve(db, businessId, input);
      if (result.status !== 'ready') throw new BadRequestException(result);
      const draft = result.draft;
      await db.$queryRaw`SELECT "id" FROM "EmployeeGroup" WHERE "businessId" = ${businessId} AND "id" = ${draft.groupId!} FOR SHARE`;
      const group = await db.employeeGroup.findFirst({
        where: { businessId, id: draft.groupId!, status: 'active' },
      });
      if (!group) throw new BadRequestException('Choose an active group.');
      const policy = await db.businessPolicy.create({
        data: {
          businessId,
          classId: draft.classId!,
          groupId: draft.groupId!,
          name: draft.name!,
          sourceText: input.text,
          durationDays: draft.durationDays,
          startsOn: new Date(`${draft.startsOn!}T00:00:00Z`),
          endsOn: new Date(`${draft.endsOn!}T00:00:00Z`),
          createdByUserId: userId,
        },
      });
      await this.audit(db, userId, businessId, 'created', {
        policyId: policy.id,
        classId: policy.classId,
        groupId: policy.groupId,
        name: policy.name,
        startsOn: draft.startsOn!,
        endsOn: draft.endsOn!,
        durationDays: policy.durationDays,
      });
      return {
        success: true,
        message: 'Policy created successfully.',
        policy,
        eligibleEmployeeCount: result.eligibleEmployeeCount,
        assignmentMode: 'explicit',
      };
    }, POLICY_TRANSACTION_OPTIONS);
  }

  async list(userId: string, businessId: string, cursor?: string) {
    await this.access.require(userId, businessId, ['policies:view']);
    const items = await this.prisma.businessPolicy.findMany({
      where: { businessId, ...(cursor ? { id: { gt: cursor } } : {}) },
      include: {
        policyClass: true,
        group: { select: { id: true, name: true, status: true } },
        _count: { select: { assignments: true } },
      },
      orderBy: { id: 'asc' },
      take: 51,
    });
    const hasMore = items.length > 50;
    if (hasMore) items.pop();
    return { items, nextCursor: hasMore ? items.at(-1)!.id : null };
  }

  async assign(
    userId: string,
    businessId: string,
    policyId: string,
    employeeId: string,
  ) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['policies:assign'], db);
      const policy = await db.businessPolicy.findFirst({
        where: { businessId, id: policyId },
      });
      if (!policy) throw new NotFoundException('Policy not found');
      await db.$queryRaw`SELECT "id" FROM "BusinessEmployee" WHERE "businessId" = ${businessId} AND "id" = ${employeeId} FOR UPDATE`;
      await db.$queryRaw`SELECT "id" FROM "EmployeeGroup" WHERE "businessId" = ${businessId} AND "id" = ${policy.groupId} FOR SHARE`;
      await db.$queryRaw`SELECT "employeeId" FROM "BusinessEmployeeGroup" WHERE "businessId" = ${businessId} AND "employeeId" = ${employeeId} AND "groupId" = ${policy.groupId} FOR SHARE`;
      const employee = await db.businessEmployee.findFirst({
        where: {
          businessId,
          id: employeeId,
          status: 'active',
          groups: {
            some: { groupId: policy.groupId, group: { status: 'active' } },
          },
        },
      });
      if (!employee)
        throw new BadRequestException(
          'Choose an active employee in this policy’s active group.',
        );
      const key = { businessId, policyId, employeeId };
      const existing = await db.employeePolicyAssignment.findUnique({
        where: { businessId_policyId_employeeId: key },
      });
      if (existing)
        return { success: true, created: false, assignment: existing };
      const assignment = await db.employeePolicyAssignment.create({
        data: { ...key, createdByUserId: userId },
      });
      await this.audit(db, userId, businessId, 'assigned', {
        assignmentId: assignment.id,
        policyId,
        employeeId,
      });
      return { success: true, created: true, assignment };
    }, POLICY_TRANSACTION_OPTIONS);
  }

  async assignments(
    userId: string,
    businessId: string,
    employeeId: string,
    cursor?: string,
  ) {
    await this.access.require(userId, businessId, [
      'policies:view',
      'employees:view',
    ]);
    const employee = await this.prisma.businessEmployee.findFirst({
      where: { businessId, id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    const items = await this.prisma.employeePolicyAssignment.findMany({
      where: {
        businessId,
        employeeId,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      include: { policy: { include: { policyClass: true } } },
      orderBy: { id: 'asc' },
      take: 51,
    });
    const hasMore = items.length > 50;
    if (hasMore) items.pop();
    return { items, nextCursor: hasMore ? items.at(-1)!.id : null };
  }
}
