import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { RedisService } from '../redis/redis.service';
import { GoogleOAuthFlowError } from './google-auth.exceptions';

const GOOGLE_AUTHORIZATION_SCOPES = ['openid', 'email', 'profile'] as const;

interface StoredGoogleAuthorization {
  codeVerifier: string;
  nonce: string;
}

interface StoredGoogleLinkIntent {
  userId: string;
  userSessionId: string;
}

export interface GoogleIdentity {
  providerUserId: string;
  email: string;
  name: string;
  avatar: string | null;
}

export interface GoogleAuthorizationRequest {
  url: string;
  state: string;
  expiresAt: Date;
}

@Injectable()
export class GoogleAuthService {
  static readonly STATE_TTL_SECONDS = 10 * 60;
  private static readonly START_LIMIT_WINDOW_SECONDS = 15 * 60;
  private static readonly MAX_STARTS_PER_SOURCE = 30;

  private readonly client: OAuth2Client;
  private readonly clientId: string;
  private readonly redirectUrl: string;
  private readonly frontendUrl: string;
  private readonly rateLimitPepper: string;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.clientId =
      configService.get<string>('GOOGLE_CLIENT_ID') ??
      configService.getOrThrow<string>('CLIENT_ID');
    const clientSecret =
      configService.get<string>('GOOGLE_CLIENT_SECRET') ??
      configService.getOrThrow<string>('CLIENT_SECRET');
    this.redirectUrl = configService.getOrThrow<string>('GOOGLE_REDIRECT_URL');
    this.frontendUrl = configService.get<string>(
      'FRONTEND_URL',
      configService.get<string>('NODE_ENV') === 'production'
        ? 'https://businesspaddi.com'
        : 'http://localhost:3000',
    );
    this.rateLimitPepper =
      configService.get<string>('RATE_LIMIT_PEPPER') ??
      configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
    this.client = new OAuth2Client(
      this.clientId,
      clientSecret,
      this.redirectUrl,
    );
  }

  async createAuthorizationRequest(
    sourceIdentifier: string,
  ): Promise<GoogleAuthorizationRequest> {
    await this.enforceStartLimit(sourceIdentifier);
    const state = this.randomUrlSafeValue();
    const nonce = this.randomUrlSafeValue();
    const codeVerifier = this.randomUrlSafeValue(64);
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const stored: StoredGoogleAuthorization = { codeVerifier, nonce };
    const storedState = await this.redis.client.set(
      this.stateKey(state),
      JSON.stringify(stored),
      {
        EX: GoogleAuthService.STATE_TTL_SECONDS,
        NX: true,
      },
    );
    if (storedState !== 'OK') {
      throw new GoogleOAuthFlowError('state_storage_failed');
    }

    return {
      state,
      expiresAt: new Date(
        Date.now() + GoogleAuthService.STATE_TTL_SECONDS * 1_000,
      ),
      url: this.client.generateAuthUrl({
        access_type: 'online',
        scope: [...GOOGLE_AUTHORIZATION_SCOPES],
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        include_granted_scopes: true,
        prompt: 'select_account',
      }),
    };
  }

  async createLinkAuthorizationRequest(
    sourceIdentifier: string,
    userId: string,
    userSessionId: string,
  ): Promise<GoogleAuthorizationRequest> {
    const authorization =
      await this.createAuthorizationRequest(sourceIdentifier);
    const stored = await this.redis.client.set(
      this.linkIntentKey(authorization.state),
      JSON.stringify({
        userId,
        userSessionId,
      } satisfies StoredGoogleLinkIntent),
      { EX: GoogleAuthService.STATE_TTL_SECONDS, NX: true },
    );
    if (stored !== 'OK') {
      await this.redis.client.del(this.stateKey(authorization.state));
      throw new GoogleOAuthFlowError('state_storage_failed');
    }
    return authorization;
  }

  async isLinkAuthorization(state: string | undefined): Promise<boolean> {
    if (!state) return false;
    return Boolean(await this.redis.client.get(this.linkIntentKey(state)));
  }

  async exchangeLinkAuthorizationCode(
    code: string | undefined,
    state: string | undefined,
    expectedState: string | null,
    providerError?: string,
  ): Promise<{ identity: GoogleIdentity; intent: StoredGoogleLinkIntent }> {
    if (!state || !expectedState || state !== expectedState) {
      throw new GoogleOAuthFlowError('invalid_state');
    }
    const storedIntent = await this.redis.client.getDel(
      this.linkIntentKey(state),
    );
    if (!storedIntent) throw new GoogleOAuthFlowError('expired_link_intent');
    const intent = this.parseLinkIntent(storedIntent);
    const identity = await this.exchangeAuthorizationCode(
      code,
      state,
      expectedState,
      providerError,
    );
    return { identity, intent };
  }

  async exchangeAuthorizationCode(
    code: string | undefined,
    state: string | undefined,
    expectedState: string | null,
    providerError?: string,
  ): Promise<GoogleIdentity> {
    if (!state || !expectedState || state !== expectedState) {
      throw new GoogleOAuthFlowError('invalid_state');
    }

    const storedValue = await this.redis.client.getDel(this.stateKey(state));
    if (!storedValue) {
      throw new GoogleOAuthFlowError('expired_or_reused_state');
    }

    if (providerError) {
      throw new GoogleOAuthFlowError('provider_denied');
    }
    if (!code) {
      throw new GoogleOAuthFlowError('authorization_code_missing');
    }

    const stored = this.parseStoredAuthorization(storedValue);

    try {
      const { tokens } = await this.client.getToken({
        code,
        codeVerifier: stored.codeVerifier,
        redirect_uri: this.redirectUrl,
      });
      if (!tokens.id_token) {
        throw new GoogleOAuthFlowError('id_token_missing');
      }

      const ticket = await this.client.verifyIdToken({
        idToken: tokens.id_token,
        audience: this.clientId,
      });
      const payload = ticket.getPayload();

      if (
        !payload?.sub ||
        !payload.email ||
        payload.email_verified !== true ||
        payload.nonce !== stored.nonce
      ) {
        throw new GoogleOAuthFlowError('identity_invalid');
      }

      const email = payload.email.trim().toLowerCase();
      const fallbackName = email.split('@')[0] || 'Business Paddi user';

      return {
        providerUserId: payload.sub,
        email,
        name: (payload.name?.trim() || fallbackName).slice(0, 40),
        avatar: payload.picture ?? null,
      };
    } catch (error: unknown) {
      if (error instanceof GoogleOAuthFlowError) {
        throw error;
      }
      throw new GoogleOAuthFlowError('token_exchange_failed');
    }
  }

  frontendCallbackUrl(
    status:
      'success' | 'verification-required' | 'account-link-required' | 'failed',
    challengeId?: string,
  ): string {
    const url = new URL('/auth/callback', this.frontendUrl);
    url.searchParams.set('provider', 'google');
    url.searchParams.set('status', status);
    if (challengeId) {
      url.searchParams.set('challengeId', challengeId);
    }
    return url.toString();
  }

  frontendLinkCallbackUrl(status: 'success' | 'failed'): string {
    const url = new URL('/settings/security', this.frontendUrl);
    url.searchParams.set('googleLink', status);
    return url.toString();
  }

  private parseLinkIntent(value: string): StoredGoogleLinkIntent {
    try {
      const parsed = JSON.parse(value) as Partial<StoredGoogleLinkIntent>;
      if (
        typeof parsed.userId === 'string' &&
        typeof parsed.userSessionId === 'string'
      ) {
        return parsed as StoredGoogleLinkIntent;
      }
    } catch {
      // A generic flow error is returned below.
    }
    throw new GoogleOAuthFlowError('link_intent_corrupted');
  }

  private parseStoredAuthorization(value: string): StoredGoogleAuthorization {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).codeVerifier === 'string' &&
        typeof (parsed as Record<string, unknown>).nonce === 'string'
      ) {
        return parsed as StoredGoogleAuthorization;
      }
    } catch {
      // The generic flow error intentionally hides corrupted transient state.
    }
    throw new GoogleOAuthFlowError('state_corrupted');
  }

  private stateKey(state: string): string {
    const digest = createHash('sha256').update(state).digest('hex');
    return `oauth:google:state:${digest}`;
  }

  private linkIntentKey(state: string): string {
    const digest = createHash('sha256').update(state).digest('hex');
    return `oauth:google:link-intent:${digest}`;
  }

  private async enforceStartLimit(sourceIdentifier: string): Promise<void> {
    const source = createHmac('sha256', this.rateLimitPepper)
      .update(`google:${sourceIdentifier}`)
      .digest('hex');
    const result = await this.redis.client.eval(
      `
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return count
      `,
      {
        keys: [`rate-limit:oauth:google:start:${source}`],
        arguments: [GoogleAuthService.START_LIMIT_WINDOW_SECONDS.toString()],
      },
    );

    if (typeof result !== 'number') {
      throw new Error('Redis returned an invalid Google rate-limit response');
    }
    if (result > GoogleAuthService.MAX_STARTS_PER_SOURCE) {
      throw new HttpException(
        'Too many Google sign-in attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private randomUrlSafeValue(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }
}
