import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { durationToSeconds } from '../common/utils/duration';
import type { AuthTokenPair } from './auth-token.types';

@Injectable()
export class AuthTokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    this.accessSecret = configService.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = configService.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.accessTtlSeconds = durationToSeconds(
      configService.getOrThrow<string>('JWT_ACCESS_EXPIRES'),
    );
    this.refreshTtlSeconds = durationToSeconds(
      configService.getOrThrow<string>('JWT_REFRESH_EXPIRES'),
    );
    this.issuer = configService.get<string>('JWT_ISSUER', 'businesspaddi-api');
    this.audience = configService.get<string>(
      'JWT_AUDIENCE',
      'businesspaddi-web',
    );
  }

  async issueTokenPair(
    userId: string,
    userSessionId: string,
  ): Promise<AuthTokenPair> {
    const issuedAtSeconds = Math.floor(Date.now() / 1_000);
    const issuedAt = issuedAtSeconds * 1_000;
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: userId,
          userSessionId,
          type: 'access',
          jti: randomUUID(),
          iat: issuedAtSeconds,
        },
        {
          secret: this.accessSecret,
          expiresIn: this.accessTtlSeconds,
          algorithm: 'HS256',
          issuer: this.issuer,
          audience: this.audience,
        },
      ),
      this.jwtService.signAsync(
        {
          sub: userId,
          userSessionId,
          type: 'refresh',
          jti: randomUUID(),
          iat: issuedAtSeconds,
        },
        {
          secret: this.refreshSecret,
          expiresIn: this.refreshTtlSeconds,
          algorithm: 'HS256',
          issuer: this.issuer,
          audience: this.audience,
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(issuedAt + this.accessTtlSeconds * 1_000),
      refreshTokenExpiresAt: new Date(
        issuedAt + this.refreshTtlSeconds * 1_000,
      ),
    };
  }

  hashRefreshToken(refreshToken: string): string {
    return createHash('sha256').update(refreshToken).digest('hex');
  }

  async verifyAccessToken(accessToken: string): Promise<AccessTokenClaims> {
    const payload = await this.jwtService.verifyAsync<Record<string, unknown>>(
      accessToken,
      {
        secret: this.accessSecret,
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      },
    );

    if (
      payload.type !== 'access' ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.userSessionId !== 'string' ||
      !payload.userSessionId ||
      typeof payload.jti !== 'string' ||
      !payload.jti
    ) {
      throw new Error('Invalid access-token claims');
    }

    return {
      userId: payload.sub,
      userSessionId: payload.userSessionId,
      tokenId: payload.jti,
    };
  }

  async verifyRefreshToken(refreshToken: string): Promise<RefreshTokenClaims> {
    const payload = await this.jwtService.verifyAsync<Record<string, unknown>>(
      refreshToken,
      {
        secret: this.refreshSecret,
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
        ignoreExpiration: true,
      },
    );

    if (
      payload.type !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.userSessionId !== 'string' ||
      !payload.userSessionId ||
      typeof payload.jti !== 'string' ||
      !payload.jti ||
      typeof payload.iat !== 'number' ||
      !Number.isSafeInteger(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= payload.iat
    ) {
      throw new Error('Invalid refresh-token claims');
    }

    return {
      userId: payload.sub,
      userSessionId: payload.userSessionId,
      tokenId: payload.jti,
      issuedAt: new Date(payload.iat * 1_000),
      expiresAt: new Date(payload.exp * 1_000),
    };
  }
}

export interface AccessTokenClaims {
  userId: string;
  userSessionId: string;
  tokenId: string;
}

export interface RefreshTokenClaims extends AccessTokenClaims {
  issuedAt: Date;
  expiresAt: Date;
}
