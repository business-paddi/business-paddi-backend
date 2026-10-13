import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, BusinessInvite } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

import { BusinessAccessService, ROLE_INCLUDE } from './business-access.service';
import { AcceptInviteDto, InviteDto } from './business.dto';
import {
  inviteResponse,
  INVITE_SELECT,
  PERSONAL_INVITE_SELECT,
} from './business.responses';

import { InviteAcceptanceService } from './invite-acceptance.service';
import { InvitePermissionsService } from './invite-permissions.service';
import { InviteEmailOutbox } from '../invite-email/invite-email-outbox.service';

type Delivery = { invite: BusinessInvite; token: string };
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class InviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly policy: InvitePermissionsService,
    private readonly outbox: InviteEmailOutbox,
    private readonly acceptance: InviteAcceptanceService,
  ) {}

  async record(
    db: Prisma.TransactionClient,
    userId: string,
    businessId: string,
    input: InviteDto,
  ): Promise<Delivery> {
    const access = await this.access.lock(userId, businessId, [], db);
    this.policy.requireInviteControls(access.permissions);
    let role = input.roleId
      ? await db.role.findUnique({
          where: { id: input.roleId },
          include: ROLE_INCLUDE,
        })
      : await db.role.findFirst({
          include: ROLE_INCLUDE,
          where: {
            key: 'employee',
            type: 'system',
            businessId: null,
            status: 'active',
          },
        });
    if (
      !role ||
      role.status !== 'active' ||
      (role.type === 'custom' && role.businessId !== businessId) ||
      (role.type === 'system' && role.key === 'owner')
    )
      throw new BadRequestException('Invalid invitation role');
    await db.$queryRaw`SELECT "id" FROM "Role" WHERE "id" = ${role.id} FOR SHARE`;
    role = await db.role.findUniqueOrThrow({
      where: { id: role.id },
      include: ROLE_INCLUDE,
    });
    if (role.status !== 'active')
      throw new BadRequestException('Invitation role is unavailable');
    if (input.employeeId) {
      const employee = await db.businessEmployee.findUnique({
        where: { businessId_id: { businessId, id: input.employeeId } },
      });
      if (
        !employee ||
        employee.status === 'archived' ||
        employee.email !== input.email ||
        employee.businessMemberId
      )
        throw new BadRequestException(
          'Employee must be unlinked with the same email in this business',
        );
    }
    const account = await db.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (account) {
      const existing = await db.businessMember.findUnique({
        where: { businessId_userId: { businessId, userId: account.id } },
        include: { role: true },
      });
      if (existing) {
        if (
          existing.status === 'active' ||
          existing.status === 'pending_approval' ||
          existing.role.key === 'owner'
        )
          throw new ConflictException(
            'Account already has a business membership',
          );
        if (existing.roleId !== role.id)
          throw new ConflictException(
            'Invitation cannot replace an existing membership role',
          );
        if (!access.permissions.includes('members:update_status'))
          throw new ForbiddenException(
            'Reactivation requires members:update_status',
          );
      }
    }
    await db.businessInvite.updateMany({
      where: { businessId, status: 'pending', expiresAt: { lte: new Date() } },
      data: { status: 'expired' },
    });
    const token = randomBytes(32).toString('hex');
    const invite = await db.businessInvite.create({
      data: {
        businessId,
        email: input.email,
        employeeId: input.employeeId,
        roleId: role.id,
        invitedByUserId: userId,
        tokenHash: tokenHash(token),
        deliveryStatus: 'pending',
        requiresApproval:
          this.policy.missingGrants(access.permissions, role).length > 0,
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    await this.outbox.record(db, invite);
    if (account) {
      await db.userNotification.create({
        data: { userId: account.id, inviteId: invite.id },
      });
    }
    return { invite, token };
  }

  async create(userId: string, businessId: string, input: InviteDto) {
    const delivery = await this.prisma.$transaction(
      (db) => this.record(db, userId, businessId, input),
      { maxWait: 15000, timeout: 30000 },
    );
    return { invitation: inviteResponse(delivery.invite) };
  }
  async list(userId: string, businessId: string) {
    return this.prisma.$transaction(
      async (db) => {
        await this.access.lock(userId, businessId, ['members:invite'], db);
        await db.businessInvite.updateMany({
          where: {
            businessId,
            status: 'pending',
            expiresAt: { lte: new Date() },
          },
          data: { status: 'expired' },
        });
        return {
          items: await db.businessInvite.findMany({
            where: { businessId },
            select: INVITE_SELECT,
            orderBy: { createdAt: 'desc' },
          }),
        };
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
  async revoke(userId: string, businessId: string, inviteId: string) {
    return this.prisma.$transaction(
      async (db) => {
        await this.access.lock(userId, businessId, ['members:invite'], db);
        const changed = await db.businessInvite.updateMany({
          where: { id: inviteId, businessId, status: 'pending' },
          data: { status: 'revoked', revokedAt: new Date() },
        });
        if (!changed.count)
          throw new ConflictException(
            'Invitation is missing or no longer pending',
          );
        await this.outbox.cancelPending(db, inviteId);
        return {
          invitation: await db.businessInvite.findUniqueOrThrow({
            where: { id: inviteId },
            select: INVITE_SELECT,
          }),
        };
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
  async resend(userId: string, businessId: string, inviteId: string) {
    const delivery = await this.prisma.$transaction(
      async (db) => {
        const access = await this.access.lock(userId, businessId, [], db);
        this.policy.requireInviteControls(access.permissions);
        await db.$queryRaw`SELECT "id" FROM "BusinessInvite" WHERE "id" = ${inviteId} AND "businessId" = ${businessId} FOR UPDATE`;
        const invite = await db.businessInvite.findFirst({
          where: { id: inviteId, businessId },
        });
        if (!invite) throw new NotFoundException('Invitation not found');
        if (invite.status !== 'pending' || invite.expiresAt <= new Date())
          throw new ConflictException(
            'Create a new invitation after expiration or revocation',
          );
        const current = await db.inviteEmailDelivery.findUnique({
          where: {
            inviteId_generation: {
              inviteId,
              generation: invite.deliveryGeneration,
            },
          },
        });
        if (current && ['pending', 'processing'].includes(current.state))
          return { invite, token: '' };
        if (current?.state === 'uncertain')
          throw new ConflictException({
            code: 'DELIVERY_UNCERTAIN',
            message:
              'Reconcile the previous delivery before sending another email',
          });
        if (
          invite.deliverySentAt &&
          Date.now() - invite.deliverySentAt.getTime() < 60000
        )
          throw new ConflictException(
            'Wait one minute before requesting another invitation email',
          );
        const token = randomBytes(32).toString('hex');
        const updated = await db.businessInvite.update({
          where: { id: inviteId },
          data: {
            tokenHash: tokenHash(token),
            deliveryStatus: 'pending',
            deliveryGeneration: { increment: 1 },
            deliveryAttempts: 0,
            deliveryProviderId: null,
            deliverySentAt: null,
            deliveryLastError: null,
          },
        });
        await this.outbox.record(db, updated);
        return { invite: updated, token };
      },
      { maxWait: 15000, timeout: 30000 },
    );
    return { invitation: inviteResponse(delivery.invite) };
  }

  async personalList(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    return {
      items: await this.prisma.businessInvite
        .findMany({
          where: { email: user.email.trim().toLowerCase() },
          select: PERSONAL_INVITE_SELECT,
          orderBy: { createdAt: 'desc' },
        })
        .then((items) =>
          items.map((invite) => ({
            ...invite,
            status:
              invite.status === 'pending' && invite.expiresAt <= new Date()
                ? ('expired' as const)
                : invite.status,
          })),
        ),
    };
  }

  async personalDetail(userId: string, inviteId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    const invite = await this.prisma.businessInvite.findFirst({
      where: { id: inviteId, email: user.email.trim().toLowerCase() },
      select: PERSONAL_INVITE_SELECT,
    });
    if (!invite) throw new NotFoundException('Invitation not found');
    const membership =
      invite.status === 'accepted'
        ? await this.prisma.businessMember.findUnique({
            where: {
              businessId_userId: { businessId: invite.businessId, userId },
            },
            select: {
              id: true,
              businessId: true,
              roleId: true,
              status: true,
              approvalStatus: true,
              approvalRequestedAt: true,
              approvalReviewedAt: true,
              approvalReason: true,
            },
          })
        : null;
    return {
      invitation: {
        ...invite,
        status:
          invite.status === 'pending' && invite.expiresAt <= new Date()
            ? ('expired' as const)
            : invite.status,
      },
      membership,
    };
  }

  accept(userId: string, input: AcceptInviteDto) {
    return this.acceptance.acceptInvitation(userId, {
      tokenHash: tokenHash(input.token),
    });
  }

  acceptById(userId: string, inviteId: string) {
    return this.acceptance.acceptInvitation(userId, { id: inviteId });
  }
}
