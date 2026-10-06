import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { GoogleOAuthFlowError } from './google-auth.exceptions';
import { GoogleAuthService } from './google-auth.service';

interface RedisClientMock {
  get: jest.Mock;
  set: jest.Mock;
  getDel: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
}

function setup(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REDIRECT_URL: 'http://localhost:3001/api/auth/google/callback',
    FRONTEND_URL: 'http://localhost:3000',
    VERIFICATION_CODE_PEPPER: 'pepper',
    ...overrides,
  };
  const config = {
    getOrThrow: (key: string): string => {
      const value = values[key];
      if (value === undefined) throw new Error(`${key} is required`);
      return value;
    },
    get: (key: string, fallback?: string): string | undefined =>
      values[key] ?? fallback,
  } as unknown as ConfigService;
  const redis: RedisClientMock = {
    get: jest.fn(),
    set: jest.fn(),
    getDel: jest.fn(),
    del: jest.fn(),
    eval: jest.fn(),
  };
  const service = new GoogleAuthService(
    { client: redis } as unknown as RedisService,
    config,
  );
  return { service, redis };
}

describe('GoogleAuthService handshake', () => {
  it('builds login callback urls with provider, status, and challengeId', () => {
    const { service } = setup();
    expect(service.frontendCallbackUrl('success')).toBe(
      'http://localhost:3000/auth/callback?provider=google&status=success',
    );
    expect(
      service.frontendCallbackUrl('verification-required', 'challenge-1'),
    ).toBe(
      'http://localhost:3000/auth/callback?provider=google&status=verification-required&challengeId=challenge-1',
    );
    expect(service.frontendLinkCallbackUrl('success')).toBe(
      'http://localhost:3000/settings/security?googleLink=success',
    );
    expect(service.frontendLinkCallbackUrl('failed')).toBe(
      'http://localhost:3000/settings/security?googleLink=failed',
    );
  });

  it('creates an authorization request with PKCE url and 10-minute state', async () => {
    const { service, redis } = setup();
    redis.eval.mockResolvedValue(1);
    redis.set.mockResolvedValue('OK');
    const before = Date.now();
    const request = await service.createAuthorizationRequest('127.0.0.1');
    expect(request.url).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(request.state).toBeTruthy();
    expect(request.expiresAt.getTime() - before).toBeGreaterThan(590_000);
    expect(request.expiresAt.getTime() - before).toBeLessThanOrEqual(601_000);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched state without touching the network', async () => {
    const { service, redis } = setup();
    await expect(
      service.exchangeAuthorizationCode('code', 'state-a', 'state-b'),
    ).rejects.toMatchObject({ reason: 'invalid_state' });
    expect(redis.getDel).not.toHaveBeenCalled();
  });

  it('surfaces provider denial before token exchange', async () => {
    const { service, redis } = setup();
    redis.getDel.mockResolvedValue(
      JSON.stringify({ codeVerifier: 'v'.repeat(43), nonce: 'n' }),
    );
    await expect(
      service.exchangeAuthorizationCode(
        undefined,
        'state',
        'state',
        'access_denied',
      ),
    ).rejects.toMatchObject({ reason: 'provider_denied' });
  });

  it('detects link callbacks from stored intents', async () => {
    const { service, redis } = setup();
    redis.get.mockResolvedValueOnce(null);
    await expect(service.isLinkAuthorization('unknown')).resolves.toBe(false);
    redis.get.mockResolvedValueOnce(JSON.stringify({ userId: 'u' }));
    await expect(service.isLinkAuthorization('known')).resolves.toBe(true);
  });

  it('uses GoogleOAuthFlowError reasons the controller maps to redirects', () => {
    expect(new GoogleOAuthFlowError('failed').reason).toBe('failed');
  });
});
