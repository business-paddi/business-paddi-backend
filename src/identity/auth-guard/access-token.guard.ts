import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthTokenService } from '../auth-token/auth-token.service';
import { PrismaService } from '../../database/prisma.service';
import type {
  AuthenticatedPrincipal,
  AuthenticatedRequest,
} from './authenticated-request';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly authTokens: AuthTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const cookies: unknown = (request as unknown as { cookies?: unknown })
      .cookies;
    const accessToken = this.isRecord(cookies)
      ? cookies.accessToken
      : undefined;

    if (typeof accessToken !== 'string' || !accessToken) {
      throw new UnauthorizedException('Authentication required');
    }

    let claims: Awaited<ReturnType<AuthTokenService['verifyAccessToken']>>;

    try {
      claims = await this.authTokens.verifyAccessToken(accessToken);
    } catch {
      throw new UnauthorizedException('Authentication required');
    }

    // One primary-database round trip for revocation, user status, and cache freshness.
    // Never cache the session check: logout/suspension must take effect on the next request.
    const [userSession] = await this.prisma.$queryRaw<
      {
        userId: string;
        currentAuthSessionId: string | null;
        revokedAt: Date | null;
        emailVerifiedAt: Date | null;
        status: string;
        revision: string;
      }[]
    >`
      SELECT s."userId", s."currentAuthSessionId", s."revokedAt",
             u."emailVerifiedAt", u."status"::text AS "status",
             COALESCE(v."revision"::text, '0') AS "revision"
      FROM "UserSession" s JOIN "User" u ON u."id" = s."userId"
      LEFT JOIN "ReadCacheRevision" v ON v."scope" = 'user' AND v."entityId" = u."id"
      WHERE s."userSessionId" = ${claims.userSessionId}
    `;

    if (
      !userSession ||
      userSession.userId !== claims.userId ||
      userSession.revokedAt ||
      !userSession.currentAuthSessionId ||
      !userSession.emailVerifiedAt ||
      userSession.status !== 'active'
    ) {
      throw new UnauthorizedException('Authentication required');
    }

    const principal: AuthenticatedPrincipal = Object.freeze({
      userId: claims.userId,
      userSessionId: claims.userSessionId,
      accessTokenId: claims.tokenId,
      userCacheRevision: userSession.revision,
    });
    (request as AuthenticatedRequest).auth = principal;

    return true;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
