import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthTokenService } from '../auth-token/auth-token.service';
import { PrismaService } from '../database/prisma.service';
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

    const userSession = await this.prisma.userSession.findUnique({
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

    if (
      !userSession ||
      userSession.userId !== claims.userId ||
      userSession.revokedAt ||
      !userSession.currentAuthSessionId ||
      !userSession.user.emailVerifiedAt ||
      userSession.user.status !== 'active'
    ) {
      throw new UnauthorizedException('Authentication required');
    }

    const principal: AuthenticatedPrincipal = Object.freeze({
      userId: claims.userId,
      userSessionId: claims.userSessionId,
      accessTokenId: claims.tokenId,
    });
    (request as AuthenticatedRequest).auth = principal;

    return true;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
