import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService, ROLE_INCLUDE } from './business-access.service';
import { InvitePermissionsService } from './invite-permissions.service';
import { membershipRoleResponse } from './business.responses';

@Injectable()
export class MemberApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly policy: InvitePermissionsService,
  ) {}

  async list(userId: string, businessId: string) {
    const actor = await this.access.require(userId, businessId, [
      'roles:assign',
    ]);
    const items = await this.prisma.businessMember.findMany({
      where: {
        businessId,
        status: 'pending_approval',
        approvalStatus: 'pending',
      },
      include: {
        user: { select: { id: true, name: true, email: true, avatar: true } },
        role: { include: ROLE_INCLUDE },
      },
      orderBy: { approvalRequestedAt: 'asc' },
    });
    return {
      items: items.map((member) => ({
        ...member,
        role: membershipRoleResponse(member.role, member.status),
        canApprove:
          member.userId !== userId &&
          this.policy.missingGrants(actor.permissions, member.role).length ===
            0,
      })),
    };
  }

  async review(
    userId: string,
    businessId: string,
    memberId: string,
    approve: boolean,
    reason?: string,
  ) {
    return this.prisma.$transaction(
      async (db) => {
        const actor = await this.access.lock(
          userId,
          businessId,
          ['roles:assign'],
          db,
        );
        await db.$queryRaw`SELECT "id" FROM "BusinessMember" WHERE "id" = ${memberId} AND "businessId" = ${businessId} FOR UPDATE`;
        const member = await db.businessMember.findFirst({
          where: { id: memberId, businessId },
        });
        if (!member) throw new NotFoundException('Business member not found');
        if (member.userId === userId)
          throw new BadRequestException(
            'You cannot review your own membership',
          );
        if (
          member.status !== 'pending_approval' ||
          member.approvalStatus !== 'pending'
        )
          throw new ConflictException(
            'Membership is no longer awaiting approval',
          );
        await db.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${member.roleId} FOR SHARE`;
        const role = await db.role.findUniqueOrThrow({
          where: { id: member.roleId },
          include: ROLE_INCLUDE,
        });
        if (
          role.status !== 'active' ||
          (role.type === 'custom' && role.businessId !== businessId) ||
          role.key === 'owner'
        )
          throw new BadRequestException('Membership role is unavailable');
        this.policy.requireAssignable(actor.permissions, role);
        const now = new Date();
        const reviewed = await db.businessMember.update({
          where: { id: memberId },
          data: {
            status: approve ? 'active' : 'removed',
            approvalStatus: approve ? 'approved' : 'rejected',
            approvalReviewedAt: now,
            approvalReviewedByUserId: userId,
            approvalReason: approve ? null : reason,
            statusUpdatedAt: now,
            statusUpdatedByUserId: userId,
            removedByUserId: approve ? null : userId,
            removedAt: approve ? null : now,
          },
          include: {
            user: {
              select: { id: true, name: true, email: true, avatar: true },
            },
            role: { include: ROLE_INCLUDE },
          },
        });
        return {
          membership: {
            ...reviewed,
            role: membershipRoleResponse(reviewed.role, reviewed.status),
          },
        };
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
}
