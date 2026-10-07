import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { Prisma } from '../../generated/prisma/client';
import { AUDIT_EVENTS } from '../audit/audit-event.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { EmailChangeVerificationService } from '../email-change-verification/email-change-verification.service';
import { EmailService } from '../email/email.service';
import type { RequestLocationContext } from '../location/location.service';
import { SensitiveActionRateLimitService } from '../rate-limit/sensitive-action-rate-limit.service';
import type { SensitiveAction } from '../sensitive-action/dto/request-sensitive-verification.dto';
import {
  PUBLIC_PREFERENCES_SELECT,
  toPublicPreferences,
} from '../onboarding/onboarding-preferences';
import { SensitiveActionVerificationService } from '../sensitive-action/sensitive-action-verification.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ConfirmEmailChangeDto } from './dto/confirm-email-change.dto';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  avatar: true,
  bio: true,
  username: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
  preferences: {
    select: PUBLIC_PREFERENCES_SELECT,
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emailChanges: EmailChangeVerificationService,
    private readonly email: EmailService,
    private readonly sensitiveRateLimits: SensitiveActionRateLimitService,
    private readonly sensitiveVerification: SensitiveActionVerificationService,
  ) {}

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        ...PUBLIC_USER_SELECT,
        passwordHash: true,
        authProviders: { select: { provider: true, linkedAt: true } },
      },
    });
    const { passwordHash, ...safeUser } = user;
    return {
      ...safeUser,
      hasPassword: Boolean(passwordHash),
      preferences: toPublicPreferences(safeUser.preferences),
    };
  }

  async updateProfile(
    userId: string,
    input: UpdateUserDto,
    context: RequestLocationContext,
  ) {
    const fields = Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    if (fields.length === 0) {
      throw new BadRequestException('At least one profile field is required');
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.update({
          where: { id: userId },
          data: {
            name: input.name,
            bio: input.bio,
            username: input.username,
            avatar: input.avatar,
          },
          select: PUBLIC_USER_SELECT,
        });
        await this.audit.record(
          {
            eventType: AUDIT_EVENTS.ACCOUNT_PROFILE_UPDATED,
            category: 'account',
            outcome: 'success',
            userId,
            context,
            metadata: { fields: fields.sort().join(',') },
          },
          transaction,
        );
        return { ...user, preferences: toPublicPreferences(user.preferences) };
      });
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('That username is unavailable');
      }
      throw error;
    }
  }

  async updatePreferences(
    userId: string,
    userSessionId: string,
    input: UpdatePreferencesDto,
    context: RequestLocationContext,
  ) {
    if (
      input.desktopNotifications === undefined &&
      input.twoFactorEnabled === undefined
    ) {
      throw new BadRequestException('At least one preference is required');
    }

    const existing = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        passwordHash: true,
        preferences: { select: { twoFactorEnabled: true } },
      },
    });
    const changingTwoFactor =
      input.twoFactorEnabled !== undefined &&
      input.twoFactorEnabled !==
        (existing.preferences?.twoFactorEnabled ?? false);
    if (changingTwoFactor) {
      await this.authorizeSensitiveAction(
        userId,
        userSessionId,
        existing.passwordHash,
        input.currentPassword,
        input.reauthToken,
        'change-two-factor',
        context,
      );
    }

    return this.prisma.$transaction(async (transaction) => {
      const preferences = await transaction.userPreference.upsert({
        where: { userId },
        create: {
          userId,
          desktopNotifications: input.desktopNotifications,
          twoFactorEnabled: input.twoFactorEnabled,
        },
        update: {
          desktopNotifications: input.desktopNotifications,
          twoFactorEnabled: input.twoFactorEnabled,
        },
        select: PUBLIC_PREFERENCES_SELECT,
      });
      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.ACCOUNT_PREFERENCES_UPDATED,
          category: 'account',
          outcome: 'success',
          userId,
          context,
          changes: {
            ...(input.desktopNotifications === undefined
              ? {}
              : { desktopNotifications: input.desktopNotifications }),
            ...(input.twoFactorEnabled === undefined
              ? {}
              : { twoFactorEnabled: input.twoFactorEnabled }),
          },
        },
        transaction,
      );
      return toPublicPreferences(preferences);
    });
  }

  async changePassword(
    userId: string,
    currentUserSessionId: string,
    input: ChangePasswordDto,
    context: RequestLocationContext,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    await this.authorizeSensitiveAction(
      userId,
      currentUserSessionId,
      user.passwordHash,
      input.currentPassword,
      input.reauthToken,
      'set-password',
      context,
    );
    if (
      user.passwordHash &&
      (await this.verifyPassword(user.passwordHash, input.newPassword))
    ) {
      throw new BadRequestException(
        'The new password must be different from the current password',
      );
    }

    const passwordHash = await hash(input.newPassword, {
      type: argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: userId },
        data: { passwordHash },
      });
      await transaction.authSession.updateMany({
        where: {
          userSession: {
            userId,
            userSessionId: { not: currentUserSessionId },
          },
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await transaction.userSession.updateMany({
        where: {
          userId,
          userSessionId: { not: currentUserSessionId },
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.ACCOUNT_PASSWORD_CHANGED,
          category: 'security',
          outcome: 'success',
          severity: 'warning',
          userId,
          userSessionId: currentUserSessionId,
          context,
          metadata: { otherSessionsRevoked: true },
        },
        transaction,
      );
    });

    return { message: 'Password changed successfully' };
  }

  async requestEmailChange(
    userId: string,
    userSessionId: string,
    input: RequestEmailChangeDto,
    context: RequestLocationContext,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, passwordHash: true },
    });
    await this.authorizeSensitiveAction(
      userId,
      userSessionId,
      user.passwordHash,
      input.currentPassword,
      input.reauthToken,
      'change-email',
      context,
    );
    if (user.email === input.newEmail) {
      throw new BadRequestException('The new email must be different');
    }
    if (
      await this.prisma.user.findUnique({
        where: { email: input.newEmail },
        select: { id: true },
      })
    ) {
      throw new ConflictException('That email address is unavailable');
    }

    const issued = await this.emailChanges.issue(userId, input.newEmail);
    try {
      await this.email.sendEmailChangeVerification({
        to: input.newEmail,
        code: issued.code,
        idempotencyKey: `email-change/${issued.deliveryId}`,
      });
    } catch (error: unknown) {
      await this.emailChanges.invalidate(issued.challengeId);
      throw error;
    }
    await this.audit.recordBestEffort({
      eventType: AUDIT_EVENTS.ACCOUNT_EMAIL_CHANGE_CODE_SENT,
      category: 'account',
      outcome: 'success',
      userId,
      email: input.newEmail,
      context,
    });

    return {
      message: 'A verification code has been sent to the new email address.',
      challengeId: issued.challengeId,
    };
  }

  async confirmEmailChange(
    userId: string,
    currentUserSessionId: string,
    input: ConfirmEmailChangeDto,
    context: RequestLocationContext,
  ) {
    const verification = await this.emailChanges.consume(
      input.challengeId,
      input.code,
    );
    if (verification.status !== 'verified' || verification.userId !== userId) {
      throw new BadRequestException(
        'The email-change code is invalid or has expired',
      );
    }

    let previousEmail = '';
    const now = new Date();
    try {
      await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.findUniqueOrThrow({
          where: { id: userId },
          select: { email: true },
        });
        previousEmail = user.email;
        await transaction.user.update({
          where: { id: userId },
          data: { email: verification.newEmail, emailVerifiedAt: now },
        });
        await transaction.authSession.updateMany({
          where: {
            userSession: {
              userId,
              userSessionId: { not: currentUserSessionId },
            },
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        await transaction.userSession.updateMany({
          where: {
            userId,
            userSessionId: { not: currentUserSessionId },
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        await this.audit.record(
          {
            eventType: AUDIT_EVENTS.ACCOUNT_EMAIL_CHANGED,
            category: 'security',
            outcome: 'success',
            severity: 'warning',
            userId,
            userSessionId: currentUserSessionId,
            email: verification.newEmail,
            context,
            metadata: { otherSessionsRevoked: true },
          },
          transaction,
        );
      });
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('That email address is unavailable');
      }
      throw error;
    }

    try {
      await this.email.sendEmailChangedNotice(previousEmail);
    } catch (error: unknown) {
      this.logger.error(
        `Could not send email-change notice: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    return { message: 'Email changed successfully' };
  }

  private async verifyPassword(
    passwordHash: string,
    password: string,
  ): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  private async authorizeSensitiveAction(
    userId: string,
    userSessionId: string,
    passwordHash: string | null,
    currentPassword: string | undefined,
    reauthToken: string | undefined,
    action: SensitiveAction,
    context: RequestLocationContext,
  ): Promise<void> {
    if (!passwordHash) {
      await this.sensitiveVerification.consumeAuthorization(
        reauthToken,
        userId,
        userSessionId,
        action,
      );
      return;
    }

    await this.sensitiveRateLimits.consume(
      userId,
      userSessionId,
      context.requestMetadata.ipAddress ??
        context.requestMetadata.requestId ??
        'unavailable',
    );
    if (
      !currentPassword ||
      !(await this.verifyPassword(passwordHash, currentPassword))
    ) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.sensitiveRateLimits.reset(userId, userSessionId);
  }

  private isUniqueConstraintError(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
