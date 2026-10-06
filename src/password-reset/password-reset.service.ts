import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { AuditService } from '../audit/audit.service';
import { AUDIT_EVENTS } from '../audit/audit-event.types';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import type { RequestLocationContext } from '../location/location.service';
import type { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';
import type { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { PasswordResetVerificationService } from './password-reset-verification.service';
import { enforceMinimumResponseTime } from '../common/utils/minimum-response-time';

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: PasswordResetVerificationService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  async request(
    input: RequestPasswordResetDto,
    context: RequestLocationContext,
  ) {
    const startedAt = Date.now();
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        emailVerifiedAt: true,
      },
    });
    const eligible = Boolean(user?.passwordHash && user.emailVerifiedAt);
    const challenge = await this.verification.issue(
      email,
      eligible ? (user?.id ?? null) : null,
      this.sourceIdentifier(context),
    );

    await this.audit.recordBestEffort({
      eventType: AUDIT_EVENTS.PASSWORD_RESET_REQUESTED,
      category: 'authentication',
      outcome: 'success',
      userId: eligible ? user?.id : undefined,
      email,
      context,
    });

    if (eligible && user) {
      try {
        await this.email.sendPasswordResetCode({
          to: user.email,
          code: challenge.code,
          idempotencyKey: `password-reset/${challenge.deliveryId}`,
        });
        await this.audit.recordBestEffort({
          eventType: AUDIT_EVENTS.PASSWORD_RESET_CODE_SENT,
          category: 'authentication',
          outcome: 'success',
          userId: user.id,
          email: user.email,
          context,
        });
      } catch (error: unknown) {
        await this.verification.invalidate(challenge.challengeId);
        this.logger.error(
          `Could not deliver password-reset email: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    await enforceMinimumResponseTime(startedAt);
    return {
      message:
        'If an eligible account exists, a password-reset code has been sent.',
      challengeId: challenge.challengeId,
    };
  }

  async confirm(
    input: ConfirmPasswordResetDto,
    context: RequestLocationContext,
  ) {
    const result = await this.verification.consume(
      input.challengeId,
      input.code,
    );
    if (result.status !== 'verified' || !result.userId) {
      await this.recordFailure(result.status, context);
      throw this.invalidChallenge();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: result.userId },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user?.passwordHash) {
      await this.recordFailure('account_unavailable', context, result.userId);
      throw this.invalidChallenge();
    }
    if (await this.passwordMatches(user.passwordHash, input.newPassword)) {
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
      const updated = await transaction.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash },
        data: { passwordHash },
      });
      if (updated.count !== 1) {
        throw this.invalidChallenge();
      }
      await transaction.authSession.updateMany({
        where: {
          userSession: { userId: user.id },
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      const sessions = await transaction.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.PASSWORD_RESET_COMPLETED,
          category: 'authentication',
          outcome: 'success',
          userId: user.id,
          email: user.email,
          context,
          metadata: { revokedSessions: sessions.count },
        },
        transaction,
      );
    });

    try {
      await this.email.sendPasswordResetNotice(user.email);
    } catch (error: unknown) {
      this.logger.error(
        `Could not deliver password-reset notice: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    return {
      message: 'Password reset successfully. Sign in with your new password.',
    };
  }

  private recordFailure(
    reason: string,
    context: RequestLocationContext,
    userId?: string,
  ): Promise<void> {
    return this.audit.recordBestEffort({
      eventType: AUDIT_EVENTS.PASSWORD_RESET_FAILED,
      category: 'authentication',
      outcome: 'failure',
      severity: 'warning',
      userId,
      context,
      reason,
    });
  }

  private invalidChallenge(): BadRequestException {
    return new BadRequestException(
      'The password-reset code is invalid or has expired',
    );
  }

  private sourceIdentifier(context: RequestLocationContext): string {
    return (
      context.requestMetadata.ipAddress ??
      context.requestMetadata.requestId ??
      'unavailable'
    );
  }

  private async passwordMatches(
    passwordHash: string,
    password: string,
  ): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
