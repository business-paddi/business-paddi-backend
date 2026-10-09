import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
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
  roleResponse,
} from './business.responses';

type Delivery = { invite: BusinessInvite; token: string };
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class InviteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
  ) {}

  async record(
    db: Prisma.TransactionClient,
    userId: string,
    businessId: string,
    input: InviteDto,
  ): Promise<Delivery> {
    const access = await this.access.lock(
      userId,
      businessId,
      ['members:invite'],
      db,
    );
    const role = input.roleId
      ? await db.role.findUnique({ where: { id: input.roleId } })
      : await db.role.findFirst({
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
    if (
      !(role.type === 'system' && role.key === 'employee') &&
      !access.permissions.includes('roles:assign')
    )
      throw new ForbiddenException('Assigning this role requires roles:assign');
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
        if (existing.status === 'active' || existing.role.key === 'owner')
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
    // No email job exists yet. A future worker must generate and persist a fresh
    // token hash when sending; this raw token is not retained for later delivery.
    const invite = await db.businessInvite.create({
      data: {
        businessId,
        email: input.email,
        employeeId: input.employeeId,
        roleId: role.id,
        invitedByUserId: userId,
        tokenHash: tokenHash(token),
        deliveryStatus: 'pending',
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    if (account) {
      await db.userNotification.create({
        data: { userId: account.id, inviteId: invite.id },
      });
    }
    return { invite, token };
  }

  async create(userId: string, businessId: string, input: InviteDto) {
    const delivery = await this.prisma.$transaction((db) =>
      this.record(db, userId, businessId, input),
    );
    return { invitation: inviteResponse(delivery.invite) };
  }
  async list(userId: string, businessId: string) {
    return this.prisma.$transaction(async (db) => {
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
    });
  }
  async revoke(userId: string, businessId: string, inviteId: string) {
    return this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['members:invite'], db);
      const changed = await db.businessInvite.updateMany({
        where: { id: inviteId, businessId, status: 'pending' },
        data: { status: 'revoked', revokedAt: new Date() },
      });
      if (!changed.count)
        throw new ConflictException(
          'Invitation is missing or no longer pending',
        );
      return {
        invitation: await db.businessInvite.findUniqueOrThrow({
          where: { id: inviteId },
          select: INVITE_SELECT,
        }),
      };
    });
  }
  async resend(userId: string, businessId: string, inviteId: string) {
    const delivery = await this.prisma.$transaction(async (db) => {
      await this.access.lock(userId, businessId, ['members:invite'], db);
      await db.$queryRaw`SELECT "id" FROM "BusinessInvite" WHERE "id" = ${inviteId} AND "businessId" = ${businessId} FOR UPDATE`;
      const invite = await db.businessInvite.findFirst({
        where: { id: inviteId, businessId },
      });
      if (!invite) throw new NotFoundException('Invitation not found');
      if (invite.status !== 'pending' || invite.expiresAt <= new Date())
        throw new ConflictException(
          'Create a new invitation after expiration or revocation',
        );
      const token = randomBytes(32).toString('hex');
      const updated = await db.businessInvite.update({
        where: { id: inviteId },
        data: { tokenHash: tokenHash(token), deliveryStatus: 'pending' },
      });
      return { invite: updated, token };
    });
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
          select: {
            ...INVITE_SELECT,
            business: { select: { id: true, name: true, profileImage: true } },
            role: { select: { id: true, name: true, key: true } },
          },
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

  accept(userId: string, input: AcceptInviteDto) {
    return this.acceptInvitation(userId, { tokenHash: tokenHash(input.token) });
  }

  acceptById(userId: string, inviteId: string) {
    return this.acceptInvitation(userId, { id: inviteId });
  }

  private async acceptInvitation(
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
          include: { role: true },
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
          ['members:invite'],
          db,
        );
        if (
          invite.role.status !== 'active' ||
          (invite.role.type === 'custom' &&
            invite.role.businessId !== invite.businessId) ||
          (invite.role.type === 'system' && invite.role.key === 'owner')
        )
          throw new BadRequestException('Invitation role is unavailable');
        if (
          !(invite.role.type === 'system' && invite.role.key === 'employee') &&
          !inviter.permissions.includes('roles:assign')
        )
          throw new ForbiddenException(
            'Inviter can no longer assign this role',
          );
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
            existing.role.key === 'owner' ||
            existing.roleId !== invite.roleId)
        )
          throw new ConflictException(
            'Existing membership cannot be replaced by this invitation',
          );
        if (existing && !inviter.permissions.includes('members:update_status'))
          throw new ForbiddenException('Inviter cannot reactivate membership');
        const now = new Date();
        const membership = existing
          ? await db.businessMember.update({
              where: { id: existing.id },
              data: {
                status: 'active',
                statusUpdatedByUserId: invite.invitedByUserId,
                statusUpdatedAt: now,
              },
              include: { role: { include: ROLE_INCLUDE } },
            })
          : await db.businessMember.create({
              data: {
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
          data: { status: 'accepted', acceptedAt: now },
          select: INVITE_SELECT,
        });
        return {
          invitation: accepted,
          membership: { ...membership, role: roleResponse(membership.role) },
        };
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
}
