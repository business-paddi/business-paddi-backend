import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  BusinessAccessService,
  ROLE_INCLUDE,
} from '../business/business-access.service';
import type { Permission } from '../business-foundation/permission-catalog';
import { fail } from './payroll-calculation';
export type Actor = {
  userId: string;
  memberId: string;
  name: string;
  avatar: string | null;
};
@Injectable()
export class PayrollAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
  ) {}
  async context(
    userId: string,
    businessId: string,
    grants: Permission[] = [],
    db: Prisma.TransactionClient = this.prisma,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userId} FOR SHARE`;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        avatar: true,
        status: true,
        emailVerifiedAt: true,
      },
    });
    if (!user || user.status !== 'active' || !user.emailVerifiedAt)
      fail('AUTHENTICATION_REQUIRED', 401);
    const a = lock
      ? await this.access.lock(
          userId,
          businessId,
          ['payments:view', ...grants],
          db,
        )
      : await this.access.require(
          userId,
          businessId,
          ['payments:view', ...grants],
          db,
        );
    if (!['approved', 'not_required'].includes(a.member.approvalStatus))
      fail('PAYROLL_ACCESS_DENIED', 403);
    return {
      ...a,
      actor: {
        userId,
        memberId: a.member.id,
        name: user.name,
        avatar: user.avatar,
      } satisfies Actor,
    };
  }
  async reviewers(
    businessId: string,
    excluded: string[],
    db: Prisma.TransactionClient = this.prisma,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT m."id" FROM "BusinessMember" m JOIN "Role" r ON r."id"=m."roleId" JOIN "User" u ON u."id"=m."userId" WHERE m."businessId"=${businessId} FOR SHARE OF m,r,u`;
    const members = await db.businessMember.findMany({
      where: {
        businessId,
        status: 'active',
        approvalStatus: { in: ['approved', 'not_required'] },
        user: { status: 'active', emailVerifiedAt: { not: null } },
        role: { status: 'active' },
        userId: { notIn: excluded },
      },
      include: { role: { include: ROLE_INCLUDE } },
    });
    return members.filter(
      (m) =>
        (m.role.type === 'system' || m.role.businessId === businessId) &&
        ['payments:view', 'payments:approve'].every(
          (p) =>
            m.role.permissions.some((g) => g.permission === p) &&
            !m.role.deniedPermissions.some((g) => g.permission === p),
        ),
    );
  }
}
export type PayrollAccess = Awaited<
  ReturnType<PayrollAccessService['context']>
>;
