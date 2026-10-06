import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import type { RequestLocationContext } from '../location/location.service';
import { SessionService } from '../session/session.service';
import { LoginRateLimitService } from '../rate-limit/login-rate-limit.service';
import { RegisterDto } from './dto/register.dto';
import { ResendEmailVerificationDto } from './dto/resend-email-verification.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { VerificationCodeService } from '../verification-code/verification-code.service';
import { LoginDto } from './dto/login.dto';
import {
  RefreshAlreadyRotatedException,
  RefreshRejectedException,
} from '../session/session.exceptions';
import { LoginVerificationService } from '../login-verification/login-verification.service';
import { VerifyLoginDto } from './dto/verify-login.dto';
import { ResendLoginVerificationDto } from './dto/resend-login-verification.dto';
import { AuditService } from '../audit/audit.service';
import { AUDIT_EVENTS } from '../audit/audit-event.types';
import {
  GoogleAccountLinkRequiredError,
  GoogleOAuthFlowError,
} from '../google-auth/google-auth.exceptions';
import {
  GoogleAuthService,
  type GoogleIdentity,
} from '../google-auth/google-auth.service';
import type { PendingAuthenticationMethod } from '../login-verification/login-verification.service';
import { AuthTokenService } from '../auth-token/auth-token.service';
import { enforceMinimumResponseTime } from '../common/utils/minimum-response-time';

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$vnqdgSXrPWJ2LQoM/KocTQ$yAo23u2KFYc+81T86cNGCfzE9LX+ylVX2F5mR09jYEQ';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verificationCodes: VerificationCodeService,
    private readonly emailService: EmailService,
    private readonly sessions: SessionService,
    private readonly loginRateLimits: LoginRateLimitService,
    private readonly loginVerifications: LoginVerificationService,
    private readonly audit: AuditService,
    private readonly googleAuth: GoogleAuthService,
    private readonly authTokens: AuthTokenService,
  ) {}

  beginGoogleLogin(context: RequestLocationContext) {
    return this.googleAuth.createAuthorizationRequest(
      this.sourceIdentifier(context),
    );
  }

  beginGoogleLink(
    userId: string,
    userSessionId: string,
    context: RequestLocationContext,
  ) {
    return this.googleAuth.createLinkAuthorizationRequest(
      this.sourceIdentifier(context),
      userId,
      userSessionId,
    );
  }

  isGoogleLinkCallback(state: string | undefined): Promise<boolean> {
    return this.googleAuth.isLinkAuthorization(state);
  }

  googleLinkCallbackRedirect(status: 'success' | 'failed'): string {
    return this.googleAuth.frontendLinkCallbackUrl(status);
  }

  async linkGoogleAccount(
    input: {
      code?: string;
      state?: string;
      error?: string;
      expectedState: string | null;
      accessToken: string | null;
    },
    context: RequestLocationContext,
  ): Promise<void> {
    let userId: string | undefined;
    try {
      if (!input.accessToken)
        throw new GoogleOAuthFlowError('authentication_required');
      const claims = await this.authTokens.verifyAccessToken(input.accessToken);
      userId = claims.userId;
      const { identity, intent } =
        await this.googleAuth.exchangeLinkAuthorizationCode(
          input.code,
          input.state,
          input.expectedState,
          input.error,
        );
      if (
        intent.userId !== claims.userId ||
        intent.userSessionId !== claims.userSessionId
      )
        throw new GoogleOAuthFlowError('link_session_mismatch');

      const session = await this.prisma.userSession.findUnique({
        where: { userSessionId: claims.userSessionId },
        select: {
          userId: true,
          currentAuthSessionId: true,
          revokedAt: true,
          user: { select: { status: true, emailVerifiedAt: true } },
        },
      });
      if (
        !session ||
        session.userId !== claims.userId ||
        session.revokedAt ||
        !session.currentAuthSessionId ||
        session.user.status !== 'active' ||
        !session.user.emailVerifiedAt
      )
        throw new GoogleOAuthFlowError('authentication_required');

      await this.prisma.$transaction(async (transaction) => {
        const ownedIdentity = await transaction.authProvider.findUnique({
          where: {
            provider_providerUserId: {
              provider: 'GOOGLE',
              providerUserId: identity.providerUserId,
            },
          },
          select: { userId: true },
        });
        if (ownedIdentity && ownedIdentity.userId !== claims.userId) {
          throw new ConflictException('This Google account is already linked');
        }
        const currentGoogle = await transaction.authProvider.findUnique({
          where: {
            userId_provider: { userId: claims.userId, provider: 'GOOGLE' },
          },
          select: { authProviderId: true, providerUserId: true },
        });
        if (
          currentGoogle &&
          currentGoogle.providerUserId !== identity.providerUserId
        )
          throw new ConflictException(
            'A different Google account is already linked',
          );
        if (!currentGoogle) {
          await transaction.authProvider.create({
            data: {
              userId: claims.userId,
              provider: 'GOOGLE',
              providerUserId: identity.providerUserId,
              providerEmail: identity.email,
            },
          });
        }
        await this.audit.record(
          {
            eventType: AUDIT_EVENTS.GOOGLE_ACCOUNT_LINKED,
            category: 'security',
            outcome: 'success',
            userId: claims.userId,
            userSessionId: claims.userSessionId,
            context,
          },
          transaction,
        );
      });
    } catch (error: unknown) {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.GOOGLE_ACCOUNT_LINK_FAILED,
        category: 'security',
        outcome: 'blocked',
        severity: 'warning',
        userId,
        context,
        reason:
          error instanceof GoogleOAuthFlowError ? error.reason : 'link_failed',
      });
      throw error;
    }
  }

  googleCallbackRedirect(
    status:
      'success' | 'verification-required' | 'account-link-required' | 'failed',
    challengeId?: string,
  ): string {
    return this.googleAuth.frontendCallbackUrl(status, challengeId);
  }

  async loginWithGoogle(
    input: {
      code?: string;
      state?: string;
      error?: string;
      expectedState: string | null;
    },
    context: RequestLocationContext,
  ) {
    let identity: GoogleIdentity | undefined;
    let userId: string | undefined;

    try {
      identity = await this.googleAuth.exchangeAuthorizationCode(
        input.code,
        input.state,
        input.expectedState,
        input.error,
      );
      const user = await this.resolveGoogleUser(identity, context);
      userId = user.id;

      if (!user.emailVerifiedAt || user.status !== 'active') {
        throw new GoogleOAuthFlowError('account_unavailable');
      }

      if (user.preferences?.twoFactorEnabled) {
        const challenge = await this.issueAndSendLoginChallenge(
          user.id,
          user.email,
          context,
          'google',
        );
        return {
          status: 'verification-required' as const,
          challengeId: challenge.challengeId,
        };
      }

      const session = await this.sessions.createLoginSession(
        user.id,
        context,
        'google',
      );
      return { status: 'authenticated' as const, session };
    } catch (error: unknown) {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.LOGIN_FAILED,
        category: 'authentication',
        outcome: 'blocked',
        severity: 'warning',
        userId,
        email: identity?.email,
        context,
        reason:
          error instanceof GoogleOAuthFlowError
            ? `google_${error.reason}`
            : error instanceof GoogleAccountLinkRequiredError
              ? 'google_account_link_required'
              : 'google_login_failed',
      });
      throw error;
    }
  }

  async login(input: LoginDto, context: RequestLocationContext) {
    const email = this.normalizeEmail(input.email);
    const sourceIdentifier =
      context.requestMetadata.ipAddress ??
      context.requestMetadata.requestId ??
      'unavailable';
    try {
      await this.loginRateLimits.consumeLoginAttempt(email, sourceIdentifier);
    } catch (error: unknown) {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.LOGIN_FAILED,
        category: 'authentication',
        outcome: 'blocked',
        severity: 'warning',
        email,
        context,
        reason: 'rate_limited',
      });
      throw error;
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        avatar: true,
        passwordHash: true,
        emailVerifiedAt: true,
        status: true,
        preferences: {
          select: { twoFactorEnabled: true },
        },
      },
    });

    const passwordMatches = await this.verifyPassword(
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      input.password,
    );

    if (!user || !user.passwordHash || !passwordMatches) {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.LOGIN_FAILED,
        category: 'authentication',
        outcome: 'failure',
        severity: 'warning',
        userId: user?.id,
        email,
        context,
        reason: 'invalid_credentials',
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.loginRateLimits.resetAccountLimit(email);

    if (!user.emailVerifiedAt) {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.LOGIN_FAILED,
        category: 'authentication',
        outcome: 'blocked',
        severity: 'warning',
        userId: user.id,
        email,
        context,
        reason: 'email_not_verified',
      });
      throw new ForbiddenException('Email verification is required');
    }

    if (user.status !== 'active') {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.LOGIN_FAILED,
        category: 'authentication',
        outcome: 'blocked',
        severity: 'warning',
        userId: user.id,
        email,
        context,
        reason: 'account_unavailable',
      });
      throw new ForbiddenException('This account is not available');
    }

    if (user.preferences?.twoFactorEnabled) {
      const challenge = await this.issueAndSendLoginChallenge(
        user.id,
        user.email,
        context,
      );

      return {
        status: 'verification-required' as const,
        challengeId: challenge.challengeId,
      };
    }

    const session = await this.sessions.createLoginSession(
      user.id,
      context,
      'password',
    );

    return {
      status: 'authenticated' as const,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        avatar: user.avatar,
      },
      session,
    };
  }

  async verifyLogin(input: VerifyLoginDto, context: RequestLocationContext) {
    const verification = await this.loginVerifications.consumeChallenge(
      input.challengeId,
      input.code,
    );

    if (verification.status !== 'verified') {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.LOGIN_VERIFICATION_FAILED,
        category: 'authentication',
        outcome: 'failure',
        severity: 'warning',
        context,
        reason: verification.status,
      });
      throw new BadRequestException(
        'The login verification code is invalid or has expired',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: verification.userId },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        avatar: true,
        emailVerifiedAt: true,
        status: true,
      },
    });

    if (!user || !user.emailVerifiedAt || user.status !== 'active') {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.LOGIN_VERIFICATION_FAILED,
        category: 'authentication',
        outcome: 'blocked',
        severity: 'warning',
        userId: user?.id ?? verification.userId,
        context,
        reason: 'account_unavailable',
      });
      throw new BadRequestException(
        'The login verification code is invalid or has expired',
      );
    }

    const session = await this.sessions.createLoginSession(
      user.id,
      context,
      verification.authenticationMethod === 'google'
        ? 'google_email_code'
        : 'password_email_code',
    );
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        avatar: user.avatar,
      },
      session,
    };
  }

  async resendLoginVerification(
    input: ResendLoginVerificationDto,
    context: RequestLocationContext,
  ) {
    const challenge = await this.loginVerifications.resendChallenge(
      input.challengeId,
      this.sourceIdentifier(context),
    );

    if (challenge) {
      const user = await this.prisma.user.findUnique({
        where: { id: challenge.userId },
        select: {
          email: true,
          emailVerifiedAt: true,
          status: true,
          preferences: { select: { twoFactorEnabled: true } },
        },
      });

      if (
        user?.emailVerifiedAt &&
        user.status === 'active' &&
        user.preferences?.twoFactorEnabled
      ) {
        try {
          await this.emailService.sendLoginVerification({
            to: user.email,
            code: challenge.code,
            idempotencyKey: `login-verification/${challenge.deliveryId}`,
          });
          await this.audit.recordBestEffort({
            eventType: AUDIT_EVENTS.LOGIN_VERIFICATION_CODE_SENT,
            category: 'authentication',
            outcome: 'success',
            userId: challenge.userId,
            email: user.email,
            context,
            reason: 'resend',
          });
        } catch (error: unknown) {
          await this.loginVerifications.invalidateCode(input.challengeId);
          throw error;
        }
      } else {
        await this.loginVerifications.invalidateChallenge(input.challengeId);
      }
    }

    return {
      message: 'If the login challenge is valid, a new code has been sent.',
    };
  }

  async refreshAuthSession(
    refreshToken: string | null,
    context: RequestLocationContext,
  ) {
    if (!refreshToken) {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.SESSION_REFRESH_REJECTED,
        category: 'session',
        outcome: 'failure',
        severity: 'warning',
        context,
        reason: 'refresh_cookie_missing',
      });
      throw new RefreshRejectedException();
    }

    const result = await this.sessions.refreshSession(refreshToken, context);

    switch (result.status) {
      case 'rotated':
        return result.tokens;
      case 'already-rotated':
        throw new RefreshAlreadyRotatedException();
      case 'rejected':
        throw new RefreshRejectedException();
    }
  }

  logout(refreshToken: string | null, context: RequestLocationContext) {
    return this.sessions.logout(refreshToken, context);
  }

  async registerUser(input: RegisterDto, context: RequestLocationContext) {
    const startedAt = Date.now();
    const email = this.normalizeEmail(input.email);
    let user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
      },
    });

    if (!user) {
      const passwordHash = await hash(input.password, {
        type: argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });

      try {
        user = await this.prisma.$transaction(async (transaction) => {
          const createdUser = await transaction.user.create({
            data: {
              email,
              name: input.name.trim(),
              passwordHash,
              preferences: { create: {} },
            },
            select: {
              id: true,
              email: true,
              emailVerifiedAt: true,
            },
          });
          await this.audit.record(
            {
              eventType: AUDIT_EVENTS.ACCOUNT_REGISTERED,
              category: 'account',
              outcome: 'success',
              userId: createdUser.id,
              email: createdUser.email,
              context,
            },
            transaction,
          );

          return createdUser;
        });
      } catch (error: unknown) {
        if (!this.isUniqueConstraintError(error)) {
          throw error;
        }

        user = await this.prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            emailVerifiedAt: true,
          },
        });
      }
    }

    if (user && !user.emailVerifiedAt) {
      await this.issueAndSendEmailCode(user.id, user.email, context);
    }

    await enforceMinimumResponseTime(startedAt);
    return {
      message:
        'If this email can be registered, a verification code has been sent.',
    };
  }

  async verifyEmail(input: VerifyEmailDto, context: RequestLocationContext) {
    const email = this.normalizeEmail(input.email);
    const result = await this.verificationCodes.consumeEmailCode(
      email,
      input.code,
    );

    if (result !== 'verified') {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.EMAIL_VERIFICATION_FAILED,
        category: 'authentication',
        outcome: 'failure',
        severity: 'warning',
        email,
        context,
        reason: result,
      });
      throw new BadRequestException(
        'The verification code is invalid or has expired',
      );
    }

    const verificationUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    const update = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.user.updateMany({
        where: {
          email,
          emailVerifiedAt: null,
        },
        data: {
          emailVerifiedAt: new Date(),
        },
      });

      if (result.count === 1) {
        await this.audit.record(
          {
            eventType: AUDIT_EVENTS.EMAIL_VERIFIED,
            category: 'authentication',
            outcome: 'success',
            userId: verificationUser?.id,
            email,
            context,
          },
          transaction,
        );
      }

      return result;
    });

    if (update.count !== 1) {
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.EMAIL_VERIFICATION_FAILED,
        category: 'authentication',
        outcome: 'blocked',
        severity: 'warning',
        email,
        context,
        reason: 'account_missing_or_already_verified',
      });
      throw new BadRequestException(
        'The verification code is invalid or has expired',
      );
    }

    return { message: 'Email verified successfully' };
  }

  async resendEmailVerification(
    input: ResendEmailVerificationDto,
    context: RequestLocationContext,
  ) {
    const email = this.normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
      },
    });

    if (user && !user.emailVerifiedAt) {
      await this.issueAndSendEmailCode(user.id, user.email, context);
    }

    return {
      message:
        'If the account exists and is unverified, a verification code has been sent.',
    };
  }

  private async issueAndSendEmailCode(
    userId: string,
    email: string,
    context: RequestLocationContext,
  ): Promise<void> {
    const issued = await this.verificationCodes.issueEmailCode(
      email,
      this.sourceIdentifier(context),
    );

    try {
      await this.emailService.sendEmailVerification({
        to: email,
        code: issued.code,
        idempotencyKey: `email-verification/${issued.deliveryId}`,
      });
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.EMAIL_VERIFICATION_CODE_SENT,
        category: 'authentication',
        outcome: 'success',
        userId,
        email,
        context,
      });
    } catch (error: unknown) {
      await this.verificationCodes.invalidateEmailCode(email);
      throw error;
    }
  }

  private async issueAndSendLoginChallenge(
    userId: string,
    email: string,
    context: RequestLocationContext,
    authenticationMethod: PendingAuthenticationMethod = 'password',
  ) {
    const challenge = await this.loginVerifications.issueChallenge(
      userId,
      this.sourceIdentifier(context),
      authenticationMethod,
    );

    try {
      await this.emailService.sendLoginVerification({
        to: email,
        code: challenge.code,
        idempotencyKey: `login-verification/${challenge.deliveryId}`,
      });
      await this.audit.recordBestEffort({
        eventType: AUDIT_EVENTS.LOGIN_VERIFICATION_CODE_SENT,
        category: 'authentication',
        outcome: 'success',
        userId,
        email,
        context,
        reason: 'initial',
      });
    } catch (error: unknown) {
      await this.loginVerifications.invalidateChallenge(challenge.challengeId);
      throw error;
    }

    return challenge;
  }

  private async resolveGoogleUser(
    identity: GoogleIdentity,
    context: RequestLocationContext,
  ) {
    const selectUser = {
      id: true,
      email: true,
      emailVerifiedAt: true,
      status: true,
      preferences: { select: { twoFactorEnabled: true } },
    } satisfies Prisma.UserSelect;

    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const linkedProvider = await transaction.authProvider.findUnique({
            where: {
              provider_providerUserId: {
                provider: 'GOOGLE',
                providerUserId: identity.providerUserId,
              },
            },
            select: {
              authProviderId: true,
              providerEmail: true,
              user: { select: selectUser },
            },
          });

          if (linkedProvider) {
            if (linkedProvider.providerEmail !== identity.email) {
              await transaction.authProvider.update({
                where: { authProviderId: linkedProvider.authProviderId },
                data: { providerEmail: identity.email },
              });
            }
            return linkedProvider.user;
          }

          const existingUser = await transaction.user.findUnique({
            where: { email: identity.email },
            select: { id: true },
          });
          if (existingUser) {
            throw new GoogleAccountLinkRequiredError();
          }

          const createdUser = await transaction.user.create({
            data: {
              email: identity.email,
              name: identity.name,
              avatar: identity.avatar,
              emailVerifiedAt: new Date(),
              preferences: { create: {} },
              authProviders: {
                create: {
                  provider: 'GOOGLE',
                  providerUserId: identity.providerUserId,
                  providerEmail: identity.email,
                },
              },
            },
            select: selectUser,
          });

          await this.audit.record(
            {
              eventType: AUDIT_EVENTS.ACCOUNT_REGISTERED,
              category: 'account',
              outcome: 'success',
              userId: createdUser.id,
              email: createdUser.email,
              context,
              metadata: { provider: 'google' },
            },
            transaction,
          );

          return createdUser;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error: unknown) {
      if (
        error instanceof GoogleAccountLinkRequiredError ||
        !this.isUniqueConstraintError(error)
      ) {
        throw error;
      }

      const concurrentlyLinked = await this.prisma.authProvider.findUnique({
        where: {
          provider_providerUserId: {
            provider: 'GOOGLE',
            providerUserId: identity.providerUserId,
          },
        },
        select: { user: { select: selectUser } },
      });
      if (!concurrentlyLinked) {
        throw new GoogleAccountLinkRequiredError();
      }
      return concurrentlyLinked.user;
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private sourceIdentifier(context: RequestLocationContext): string {
    return (
      context.requestMetadata.ipAddress ??
      context.requestMetadata.requestId ??
      'unavailable'
    );
  }

  private isUniqueConstraintError(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
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
}
