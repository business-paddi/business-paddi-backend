import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthTokenPair } from '../auth-token/auth-token.types';
import {
  AuthTokenService,
  type RefreshTokenClaims,
} from '../auth-token/auth-token.service';
import { PrismaService } from '../database/prisma.service';
import type { RequestLocationContext } from '../location/location.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_EVENTS } from '../audit/audit-event.types';

export interface CreatedLoginSession {
  userSessionId: string;
  tokens: AuthTokenPair;
}

export type RefreshSessionResult =
  | { status: 'rotated'; tokens: AuthTokenPair }
  | { status: 'already-rotated' }
  | { status: 'rejected' };

class RotationLostError extends Error {}

@Injectable()
export class SessionService {
  private static readonly ROTATION_GRACE_MILLISECONDS = 60 * 1_000;
  private static readonly EXPIRY_TOLERANCE_MILLISECONDS = 2 * 1_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authTokens: AuthTokenService,
    private readonly audit: AuditService,
  ) {}

  async listUserSessions(userId: string, currentUserSessionId: string) {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        userSessionId: true,
        userAgent: true,
        deviceName: true,
        ipAddress: true,
        city: true,
        region: true,
        country: true,
        lastSeenAt: true,
        createdAt: true,
        revokedAt: true,
        authSessions: {
          where: { revokedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { expiresAt: true },
        },
      },
    });

    return sessions.map(({ authSessions, ...session }) => ({
      ...session,
      isCurrent: session.userSessionId === currentUserSessionId,
      expiresAt: authSessions[0]?.expiresAt ?? null,
    }));
  }

  async revokeUserSession(
    userId: string,
    currentUserSessionId: string,
    targetUserSessionId: string,
    context: RequestLocationContext,
  ) {
    const target = await this.prisma.userSession.findFirst({
      where: { userSessionId: targetUserSessionId, userId },
      select: { userSessionId: true, revokedAt: true },
    });
    if (!target) {
      throw new NotFoundException('Session not found');
    }

    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.authSession.updateMany({
        where: { userSessionId: targetUserSessionId, revokedAt: null },
        data: { revokedAt: now },
      });
      await transaction.userSession.updateMany({
        where: {
          userSessionId: targetUserSessionId,
          userId,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.SESSION_REVOKED,
          category: 'session',
          outcome: 'success',
          userId,
          userSessionId: targetUserSessionId,
          context,
          reason:
            targetUserSessionId === currentUserSessionId
              ? 'current_session_revoked'
              : 'user_revoked_session',
        },
        transaction,
      );
    });

    return {
      message: 'Session revoked successfully',
      currentSessionRevoked: targetUserSessionId === currentUserSessionId,
    };
  }

  async revokeOtherUserSessions(
    userId: string,
    currentUserSessionId: string,
    context: RequestLocationContext,
  ) {
    const now = new Date();
    const revoked = await this.prisma.$transaction(async (transaction) => {
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
      const result = await transaction.userSession.updateMany({
        where: {
          userId,
          userSessionId: { not: currentUserSessionId },
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.SESSION_REVOKED,
          category: 'session',
          outcome: 'success',
          userId,
          userSessionId: currentUserSessionId,
          context,
          reason: 'other_sessions_revoked',
          metadata: { revokedCount: result.count },
        },
        transaction,
      );
      return result.count;
    });

    return { message: 'Other sessions revoked successfully', revoked };
  }

  createLoginSession(
    userId: string,
    context: RequestLocationContext,
    authenticationMethod:
      | 'password'
      | 'password_email_code'
      | 'google'
      | 'google_email_code' = 'password',
  ): Promise<CreatedLoginSession> {
    return this.prisma.$transaction(async (transaction) => {
      const sessionsOverLimit = await transaction.userSession.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        skip: 9,
        select: { userSessionId: true },
      });
      if (sessionsOverLimit.length > 0) {
        const ids = sessionsOverLimit.map((session) => session.userSessionId);
        const now = new Date();
        await transaction.authSession.updateMany({
          where: { userSessionId: { in: ids }, revokedAt: null },
          data: { revokedAt: now },
        });
        await transaction.userSession.updateMany({
          where: { userSessionId: { in: ids }, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      const userSession = await transaction.userSession.create({
        data: {
          userId,
          currentAuthSessionId: null,
          userAgent: context.requestMetadata.userAgent,
          ipAddress: context.requestMetadata.ipAddress,
          city: context.location.city,
          region: context.location.region,
          country: context.location.country,
        },
        select: { userSessionId: true },
      });

      const tokens = await this.authTokens.issueTokenPair(
        userId,
        userSession.userSessionId,
      );

      const authSession = await transaction.authSession.create({
        data: {
          userSessionId: userSession.userSessionId,
          refreshTokenHash: this.authTokens.hashRefreshToken(
            tokens.refreshToken,
          ),
          expiresAt: tokens.refreshTokenExpiresAt,
        },
        select: { authSessionId: true },
      });

      await transaction.userSession.update({
        where: { userSessionId: userSession.userSessionId },
        data: { currentAuthSessionId: authSession.authSessionId },
      });

      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.LOGIN_SUCCEEDED,
          category: 'authentication',
          outcome: 'success',
          userId,
          userSessionId: userSession.userSessionId,
          authSessionId: authSession.authSessionId,
          context,
          metadata: { authenticationMethod },
        },
        transaction,
      );

      return {
        userSessionId: userSession.userSessionId,
        tokens,
      };
    });
  }

  async logout(
    refreshToken: string | null,
    context: RequestLocationContext,
  ): Promise<void> {
    if (!refreshToken) return;
    try {
      const claims = await this.authTokens.verifyRefreshToken(refreshToken);
      const now = new Date();
      await this.prisma.$transaction(async (transaction) => {
        const session = await transaction.userSession.findFirst({
          where: {
            userSessionId: claims.userSessionId,
            userId: claims.userId,
          },
          select: { userSessionId: true },
        });
        if (!session) return;
        await transaction.authSession.updateMany({
          where: { userSessionId: claims.userSessionId, revokedAt: null },
          data: { revokedAt: now },
        });
        await transaction.userSession.updateMany({
          where: {
            userSessionId: claims.userSessionId,
            userId: claims.userId,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        await this.audit.record(
          {
            eventType: AUDIT_EVENTS.SESSION_REVOKED,
            category: 'session',
            outcome: 'success',
            userId: claims.userId,
            userSessionId: claims.userSessionId,
            context,
            reason: 'logout',
          },
          transaction,
        );
      });
    } catch {
      // Logout remains idempotent and cookie clearing must always continue.
    }
  }

  async refreshSession(
    refreshToken: string,
    context: RequestLocationContext,
  ): Promise<RefreshSessionResult> {
    let claims: RefreshTokenClaims;

    try {
      claims = await this.authTokens.verifyRefreshToken(refreshToken);
    } catch {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.SESSION_REFRESH_REJECTED,
        category: 'session',
        outcome: 'failure',
        severity: 'warning',
        context,
        reason: 'invalid_refresh_credential',
      });
      return { status: 'rejected' };
    }

    const refreshTokenHash = this.authTokens.hashRefreshToken(refreshToken);
    const now = new Date();

    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const userSession = await transaction.userSession.findUnique({
            where: { userSessionId: claims.userSessionId },
            select: {
              userId: true,
              currentAuthSessionId: true,
              revokedAt: true,
              user: {
                select: {
                  emailVerifiedAt: true,
                  status: true,
                },
              },
            },
          });

          if (!userSession || userSession.revokedAt) {
            await this.audit.record(
              {
                eventType: AUDIT_EVENTS.SESSION_REFRESH_REJECTED,
                category: 'session',
                outcome: 'blocked',
                severity: 'warning',
                userSessionId: claims.userSessionId,
                context,
                reason: userSession ? 'session_revoked' : 'session_missing',
              },
              transaction,
            );
            return { status: 'rejected' } as const;
          }

          if (
            userSession.userId !== claims.userId ||
            !userSession.user.emailVerifiedAt ||
            userSession.user.status !== 'active' ||
            !userSession.currentAuthSessionId
          ) {
            return this.revokeSessionChain(
              transaction,
              claims.userSessionId,
              now,
              'session_identity_inconsistent',
              context,
            );
          }

          const startingCurrentAuthSessionId = userSession.currentAuthSessionId;
          const currentAuthSession = await transaction.authSession.findUnique({
            where: { authSessionId: startingCurrentAuthSessionId },
            select: {
              authSessionId: true,
              userSessionId: true,
              refreshTokenHash: true,
              replacedByAuthSessionId: true,
              expiresAt: true,
              revokedAt: true,
            },
          });

          if (
            !currentAuthSession ||
            currentAuthSession.userSessionId !== claims.userSessionId
          ) {
            return this.revokeSessionChain(
              transaction,
              claims.userSessionId,
              now,
              'current_auth_session_inconsistent',
              context,
            );
          }

          if (currentAuthSession.refreshTokenHash !== refreshTokenHash) {
            return this.classifyReplacedToken(
              transaction,
              claims.userSessionId,
              refreshTokenHash,
              now,
              context,
            );
          }

          if (
            currentAuthSession.revokedAt ||
            currentAuthSession.replacedByAuthSessionId ||
            claims.expiresAt.getTime() >
              currentAuthSession.expiresAt.getTime() +
                SessionService.EXPIRY_TOLERANCE_MILLISECONDS
          ) {
            return this.revokeSessionChain(
              transaction,
              claims.userSessionId,
              now,
              'refresh_state_inconsistent',
              context,
            );
          }

          if (
            claims.expiresAt.getTime() <= now.getTime() ||
            currentAuthSession.expiresAt.getTime() <= now.getTime()
          ) {
            return this.revokeSessionChain(
              transaction,
              claims.userSessionId,
              now,
              'refresh_expired',
              context,
            );
          }

          const replacementAuthSessionId = randomUUID();
          const tokens = await this.authTokens.issueTokenPair(
            claims.userId,
            claims.userSessionId,
          );
          const claim = await transaction.authSession.updateMany({
            where: {
              authSessionId: startingCurrentAuthSessionId,
              userSessionId: claims.userSessionId,
              refreshTokenHash,
              replacedByAuthSessionId: null,
              revokedAt: null,
              expiresAt: { gt: now },
            },
            data: {
              replacedByAuthSessionId: replacementAuthSessionId,
              revokedAt: now,
              lastSeenAt: now,
            },
          });

          if (claim.count !== 1) {
            throw new RotationLostError();
          }

          await transaction.authSession.create({
            data: {
              authSessionId: replacementAuthSessionId,
              userSessionId: claims.userSessionId,
              refreshTokenHash: this.authTokens.hashRefreshToken(
                tokens.refreshToken,
              ),
              expiresAt: tokens.refreshTokenExpiresAt,
            },
          });

          const pin = await transaction.userSession.updateMany({
            where: {
              userSessionId: claims.userSessionId,
              currentAuthSessionId: startingCurrentAuthSessionId,
              revokedAt: null,
            },
            data: {
              currentAuthSessionId: replacementAuthSessionId,
              lastSeenAt: now,
            },
          });

          if (pin.count !== 1) {
            throw new RotationLostError();
          }

          await this.audit.record(
            {
              eventType: AUDIT_EVENTS.SESSION_REFRESHED,
              category: 'session',
              outcome: 'success',
              userId: claims.userId,
              userSessionId: claims.userSessionId,
              authSessionId: replacementAuthSessionId,
              context,
            },
            transaction,
          );

          return { status: 'rotated', tokens } as const;
        },
        {
          maxWait: 5_000,
          timeout: 10_000,
        },
      );
    } catch (error: unknown) {
      if (error instanceof RotationLostError) {
        await this.audit.recordBestEffort({
          eventType: AUDIT_EVENTS.SESSION_REFRESH_REJECTED,
          category: 'session',
          outcome: 'blocked',
          userId: claims.userId,
          userSessionId: claims.userSessionId,
          context,
          reason: 'concurrent_rotation_lost',
        });
        return { status: 'already-rotated' };
      }

      throw error;
    }
  }

  private async classifyReplacedToken(
    transaction: Prisma.TransactionClient,
    userSessionId: string,
    refreshTokenHash: string,
    now: Date,
    context: RequestLocationContext,
  ): Promise<RefreshSessionResult> {
    const presentedAuthSession = await transaction.authSession.findUnique({
      where: { refreshTokenHash },
      select: {
        userSessionId: true,
        replacedByAuthSessionId: true,
        revokedAt: true,
      },
    });

    if (
      !presentedAuthSession ||
      presentedAuthSession.userSessionId !== userSessionId ||
      !presentedAuthSession.replacedByAuthSessionId ||
      !presentedAuthSession.revokedAt
    ) {
      return this.revokeSessionChain(
        transaction,
        userSessionId,
        now,
        'presented_auth_session_inconsistent',
        context,
      );
    }

    const timeSinceRotation =
      now.getTime() - presentedAuthSession.revokedAt.getTime();

    if (
      timeSinceRotation >= 0 &&
      timeSinceRotation <= SessionService.ROTATION_GRACE_MILLISECONDS
    ) {
      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.SESSION_REFRESH_REJECTED,
          category: 'session',
          outcome: 'blocked',
          severity: 'info',
          userSessionId,
          context,
          reason: 'recently_rotated',
        },
        transaction,
      );
      return { status: 'already-rotated' };
    }

    return this.revokeSessionChain(
      transaction,
      userSessionId,
      now,
      'late_refresh_replay',
      context,
    );
  }

  private async revokeSessionChain(
    transaction: Prisma.TransactionClient,
    userSessionId: string,
    now: Date,
    reason: string,
    context: RequestLocationContext,
  ): Promise<{ status: 'rejected' }> {
    await transaction.userSession.updateMany({
      where: {
        userSessionId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    await transaction.authSession.updateMany({
      where: {
        userSessionId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    await this.audit.record(
      {
        eventType: AUDIT_EVENTS.SESSION_REPLAY_DETECTED,
        category: 'security',
        outcome: 'blocked',
        severity: reason === 'late_refresh_replay' ? 'critical' : 'warning',
        userSessionId,
        context,
        reason,
      },
      transaction,
    );

    return { status: 'rejected' };
  }
}
