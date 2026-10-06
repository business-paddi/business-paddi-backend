import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AuthTokenPair } from '../auth-token/auth-token.types';

@Injectable()
export class AuthCookieService {
  private static readonly GOOGLE_OAUTH_STATE_COOKIE = 'googleOAuthState';
  private readonly secure: boolean;

  constructor(configService: ConfigService) {
    const production = configService.get<string>('NODE_ENV') === 'production';
    const configured = configService.get<string>('COOKIE_SECURE');
    if (production && configured !== 'true') {
      throw new Error('COOKIE_SECURE must be true in production');
    }
    this.secure = configured === 'true';
  }

  setAuthCookies(response: Response, tokens: AuthTokenPair): void {
    const sharedOptions = {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax' as const,
    };

    response.cookie('accessToken', tokens.accessToken, {
      ...sharedOptions,
      path: '/api',
      expires: tokens.accessTokenExpiresAt,
    });
    response.cookie('refreshToken', tokens.refreshToken, {
      ...sharedOptions,
      path: '/api/auth',
      expires: tokens.refreshTokenExpiresAt,
    });
  }

  getRefreshToken(request: Request): string | null {
    return this.getCookie(request, 'refreshToken');
  }

  getAccessToken(request: Request): string | null {
    return this.getCookie(request, 'accessToken');
  }

  setGoogleOAuthStateCookie(
    response: Response,
    state: string,
    expiresAt: Date,
  ): void {
    response.cookie(AuthCookieService.GOOGLE_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/api/auth/google/callback',
      expires: expiresAt,
    });
  }

  getGoogleOAuthState(request: Request): string | null {
    return this.getCookie(request, AuthCookieService.GOOGLE_OAUTH_STATE_COOKIE);
  }

  clearGoogleOAuthStateCookie(response: Response): void {
    response.clearCookie(AuthCookieService.GOOGLE_OAUTH_STATE_COOKIE, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/api/auth/google/callback',
    });
  }

  private getCookie(request: Request, name: string): string | null {
    const cookies: unknown = (request as unknown as { cookies?: unknown })
      .cookies;

    if (typeof cookies !== 'object' || cookies === null) {
      return null;
    }

    const value = (cookies as Record<string, unknown>)[name];
    return typeof value === 'string' && value ? value : null;
  }

  clearAuthCookies(response: Response): void {
    const sharedOptions = {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax' as const,
    };

    response.clearCookie('accessToken', {
      ...sharedOptions,
      path: '/api',
    });
    response.clearCookie('refreshToken', {
      ...sharedOptions,
      path: '/api/auth',
    });
  }
}
