import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService, ROLE_INCLUDE } from './business-access.service';
import { INVITE_SELECT, membershipRoleResponse } from './business.responses';
import { InvitePermissionsService } from './invite-permissions.service';
import { InviteEmailOutbox } from '../invite-email/invite-email-outbox.service';

@Injectable()
export class InviteAcceptanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly policy: InvitePermissionsService,
    private readonly outbox: InviteEmailOutbox,
  ) {}
  async acceptInvitation(
    userId: string,
    where: Prisma.BusinessInviteWhereUniqueInput,
  ) {
    return this.prisma.$transaction(
      async (db) => {
        if (where.id) {
          await db.$queryRaw`SELECT "id" FROM "BusinessInvite" WHERE "id" = ${where.id} FOR UPDATE`;
        } else {
          await db.$queryRaw`SELECT "id" FROM "BusinessInvite" WHERE "tokenHash" = ${where.tokenHash} FOR UPDATE`;
        }
        const invite = await db.businessInvite.findUnique({
          where,
          include: { role: { include: ROLE_INCLUDE } },
        });
        if (!invite) throw new BadRequestException('Invalid invitation token');
        if (invite.status !== 'pending')
          throw new ConflictException('Invitation is no longer pending');
        if (invite.expiresAt <= new Date())
          throw new GoneException('Invitation expired');
        await db.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { email: true, emailVerifiedAt: true, status: true },
        });
        if (
          !user ||
          !user.emailVerifiedAt ||
          user.status !== 'active' ||
          user.email.trim().toLowerCase() !== invite.email
        )
          throw new ForbiddenException(
            'Verified control of the invited email is required',
          );
        const inviter = await this.access.lock(
          invite.invitedByUserId,
          invite.businessId,
          [],
          db,
        );
        if (
          invite.role.status !== 'active' ||
          (invite.role.type === 'custom' &&
            invite.role.businessId !== invite.businessId) ||
          (invite.role.type === 'system' && invite.role.key === 'owner')
        )
          throw new BadRequestException('Invitation role is unavailable');
        this.policy.requireInviteControls(inviter.permissions);
        await db.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${invite.roleId} FOR SHARE`;
        const targetRole = await db.role.findUniqueOrThrow({
          where: { id: invite.roleId },
          include: ROLE_INCLUDE,
        });
        if (targetRole.status !== 'active')
          throw new BadRequestException('Invitation role is unavailable');
        const requiresApproval =
          invite.requiresApproval ||
          this.policy.missingGrants(inviter.permissions, targetRole).length > 0;
        await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${invite.businessId + '/' + userId}, 0))::text`;
        await db.$queryRaw`SELECT "id" FROM "BusinessMember" WHERE "businessId" = ${invite.businessId} AND "userId" = ${userId} FOR UPDATE`;
        const existing = await db.businessMember.findUnique({
          where: {
            businessId_userId: { businessId: invite.businessId, userId },
          },
          include: { role: true },
        });
        if (
          existing &&
          (existing.status === 'active' ||
            existing.status === 'pending_approval' ||
            existing.role.key === 'owner' ||
            existing.roleId !== invite.roleId)
        )
          throw new ConflictException(
            'Existing membership cannot be replaced by this invitation',
          );
        if (existing && !inviter.permissions.includes('members:update_status'))
          throw new ForbiddenException('Inviter cannot reactivate membership');
        const now = new Date();
        await db.$queryRaw`SELECT set_config('business_paddi.actor_id', ${userId}, true)`;
        const approvalData = {
          status: requiresApproval
            ? ('pending_approval' as const)
            : ('active' as const),
          approvalStatus: requiresApproval
            ? ('pending' as const)
            : ('not_required' as const),
          approvalRequestedAt: requiresApproval ? now : null,
          approvalReviewedAt: null,
          approvalReviewedByUserId: null,
          approvalReason: null,
        };
        const membership = existing
          ? await db.businessMember.update({
              where: { id: existing.id },
              data: {
                ...approvalData,
                statusUpdatedByUserId: invite.invitedByUserId,
                statusUpdatedAt: now,
              },
              include: { role: { include: ROLE_INCLUDE } },
            })
          : await db.businessMember.create({
              data: {
                ...approvalData,
                businessId: invite.businessId,
                userId,
                roleId: invite.roleId,
                invitedByUserId: invite.invitedByUserId,
              },
              include: { role: { include: ROLE_INCLUDE } },
            });
        if (invite.employeeId) {
          await db.$queryRaw`SELECT "id" FROM "BusinessEmployee" WHERE "businessId" = ${invite.businessId} AND "id" = ${invite.employeeId} FOR UPDATE`;
          const employee = await db.businessEmployee.findUnique({
            where: {
              businessId_id: {
                businessId: invite.businessId,
                id: invite.employeeId,
              },
            },
          });
          if (
            !employee ||
            employee.status === 'archived' ||
            employee.email !== invite.email ||
            (employee.businessMemberId &&
              employee.businessMemberId !== membership.id)
          )
            throw new ConflictException(
              'Invited employee is no longer eligible for linking',
            );
          await db.businessEmployee.update({
            where: {
              businessId_id: {
                businessId: invite.businessId,
                id: invite.employeeId,
              },
            },
            data: { businessMemberId: membership.id },
          });
        }
        const accepted = await db.businessInvite.update({
          where: { id: invite.id },
          data: { status: 'accepted', acceptedAt: now, requiresApproval },
          select: INVITE_SELECT,
        });
        await this.outbox.cancelPending(db, invite.id);
        return {
          invitation: accepted,
          membership: {
            ...membership,
            role: membershipRoleResponse(membership.role, membership.status),
          },
        };
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
}
