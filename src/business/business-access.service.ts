import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { Permission } from '../business-foundation/permission-catalog';
import { PrismaService } from '../database/prisma.service';

export const ROLE_INCLUDE = {
  permissions: true,
  deniedPermissions: true,
} as const;
export type Access = Awaited<ReturnType<BusinessAccessService['require']>>;

@Injectable()
export class BusinessAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async require(
    userId: string,
    businessId: string,
    permissions: Permission[] = [],
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const member = await db.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId } },
      include: { role: { include: ROLE_INCLUDE }, business: true },
    });
    // Hide tenant existence from outsiders.
    if (!member) throw new NotFoundException('Business not found');
    if (
      member.status !== 'active' ||
      member.role.status !== 'active' ||
      (member.role.type === 'custom' && member.role.businessId !== businessId)
    ) {
      throw new ForbiddenException('Business access denied');
    }
    if (member.business.status !== 'active')
      throw new ForbiddenException('Business is not active');
    const denied = new Set(
      member.role.deniedPermissions.map((p) => p.permission),
    );
    const effective = member.role.permissions
      .map((p) => p.permission)
      .filter((p) => !denied.has(p));
    if (permissions.some((p) => !effective.includes(p)))
      throw new ForbiddenException('Missing business permission');
    return { member, permissions: effective };
  }

  // Lock authorization records for mutations so concurrent suspension/role changes cannot race the write.
  async lock(
    userId: string,
    businessId: string,
    permissions: Permission[],
    db: Prisma.TransactionClient,
  ) {
    await db.$queryRaw`SELECT m."id" FROM "BusinessMember" m JOIN "Role" r ON r."id" = m."roleId" JOIN "Business" b ON b."id" = m."businessId" WHERE m."businessId" = ${businessId} AND m."userId" = ${userId} FOR SHARE OF m, r, b`;
    return this.require(userId, businessId, permissions, db);
  }
}
