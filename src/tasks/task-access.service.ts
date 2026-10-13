import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { BusinessTask, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  BusinessAccessService,
  ROLE_INCLUDE,
} from '../business/business-access.service';
import type { Access } from '../business/business-access.service';
export type TaskIdentity = {
  memberId: string;
  userId: string;
  name: string;
  avatar: string | null;
  employeeId: string | null;
  employeeName: string | null;
  employeePhoto: string | null;
};
@Injectable()
export class TaskAccessService {
  constructor(
    private readonly prisma: PrismaService,
    readonly businesses: BusinessAccessService,
  ) {}
  isEligible(access: Access) {
    return ['approved', 'not_required'].includes(access.member.approvalStatus);
  }
  async context(
    userId: string,
    businessId: string,
    db: Prisma.TransactionClient = this.prisma,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId} FOR SHARE`;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { status: true, emailVerifiedAt: true },
    });
    if (!user || user.status !== 'active' || !user.emailVerifiedAt)
      throw new UnauthorizedException('Authentication required');
    const a = lock
      ? await this.businesses.lock(userId, businessId, [], db)
      : await this.businesses.require(userId, businessId, [], db);
    if (!this.isEligible(a))
      throw new ForbiddenException('Business access denied');
    return a;
  }
  grant(a: Access, p: string) {
    if (!a.permissions.includes(p))
      throw new ForbiddenException({
        code: 'MISSING_TASK_CAPABILITY',
        message: `Missing ${p}`,
        missingPermissions: [p],
      });
  }
  visible(a: Access, t: BusinessTask) {
    return (
      a.permissions.includes('task:view') ||
      (a.permissions.includes('task:review') &&
        t.reviewerMemberId === a.member.id) ||
      t.createdByMemberId === a.member.id ||
      t.assigneeMemberId === a.member.id
    );
  }
  canComment(a: Access, t: BusinessTask) {
    return (
      t.assigneeMemberId === a.member.id ||
      t.createdByMemberId === a.member.id ||
      ['task:update', 'task:assign', 'task:review'].some((p) =>
        a.permissions.includes(p),
      )
    );
  }
  async task(
    a: Access,
    id: string,
    db: Prisma.TransactionClient = this.prisma,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT "id" FROM "BusinessTask" WHERE "businessId"=${a.member.businessId} AND "id"=${id} FOR UPDATE`;
    const t = await db.businessTask.findFirst({
      where: { id, businessId: a.member.businessId },
    });
    if (!t || !this.visible(a, t))
      throw new NotFoundException('Task not found');
    return t;
  }
  async identity(
    a: Access,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<TaskIdentity> {
    const u = await db.user.findUniqueOrThrow({
      where: { id: a.member.userId },
      select: { id: true, name: true, avatar: true },
    });
    return {
      memberId: a.member.id,
      userId: u.id,
      name: u.name,
      avatar: u.avatar,
      employeeId: null,
      employeeName: null,
      employeePhoto: null,
    };
  }
  async candidate(
    businessId: string,
    memberId: string,
    employeeId: string | undefined,
    db: Prisma.TransactionClient,
    lock = true,
  ): Promise<TaskIdentity> {
    if (lock)
      await db.$queryRaw`SELECT m."id" FROM "BusinessMember" m JOIN "Role" r ON r."id"=m."roleId" JOIN "User" u ON u."id"=m."userId" WHERE m."id"=${memberId} AND m."businessId"=${businessId} FOR SHARE OF m,r,u`;
    const m = await db.businessMember.findFirst({
      where: {
        id: memberId,
        businessId,
        status: 'active',
        approvalStatus: { in: ['approved', 'not_required'] },
        role: { status: 'active' },
        user: { status: 'active', emailVerifiedAt: { not: null } },
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        role: { include: ROLE_INCLUDE },
      },
    });
    if (!m || (m.role.type === 'custom' && m.role.businessId !== businessId))
      throw new BadRequestException({
        code: 'INELIGIBLE_ASSIGNEE',
        message: 'Assignee must be an active eligible member of this business',
      });
    let employee: { id: string; fullName: string } | null = null;
    if (employeeId) {
      if (lock)
        await db.$queryRaw`SELECT "id" FROM "BusinessEmployee" WHERE "id"=${employeeId} AND "businessId"=${businessId} FOR SHARE`;
      employee = await db.businessEmployee.findFirst({
        where: {
          id: employeeId,
          businessId,
          businessMemberId: memberId,
          status: 'active',
        },
        select: { id: true, fullName: true },
      });
      if (!employee)
        throw new BadRequestException({
          code: 'INELIGIBLE_EMPLOYEE',
          message: 'Employee must be active and linked to this assignee',
        });
    }
    return {
      memberId: m.id,
      userId: m.userId,
      name: m.user.name,
      avatar: m.user.avatar,
      employeeId: employee?.id ?? null,
      employeeName: employee?.fullName ?? null,
      employeePhoto: employee ? m.user.avatar : null,
    };
  }
  async reviewer(
    businessId: string,
    reviewerId: string | null,
    assigneeId: string | null,
    db: Prisma.TransactionClient,
  ) {
    if (!reviewerId || reviewerId === assigneeId)
      throw new BadRequestException({
        code: 'REVIEWER_REQUIRED',
        message: 'Configure an eligible reviewer other than the assignee',
      });
    const identity = await this.candidate(
      businessId,
      reviewerId,
      undefined,
      db,
    );
    const a = await this.context(identity.userId, businessId, db);
    if (!a.permissions.includes('task:review'))
      throw new BadRequestException({
        code: 'INELIGIBLE_REVIEWER',
        message: 'Reviewer needs task:review',
      });
  }
  async ownAssignment(
    a: Access,
    t: BusinessTask,
    db: Prisma.TransactionClient,
  ) {
    if (t.assigneeMemberId !== a.member.id || !t.assignmentId)
      throw new ForbiddenException('Only the current assignee can act');
    const assignment = await db.taskAssignment.findUniqueOrThrow({
      where: { id: t.assignmentId },
    });
    await this.candidate(
      t.businessId,
      assignment.memberId,
      assignment.employeeId ?? undefined,
      db,
    );
    return assignment;
  }
}
