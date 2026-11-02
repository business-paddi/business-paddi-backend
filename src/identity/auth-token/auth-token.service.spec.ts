import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthTokenService } from './auth-token.service';

describe('AuthTokenService defaults', () => {
  it('issues tokens with the Business Paddi issuer/audience by default', async () => {
    const values: Record<string, string> = {
      JWT_ACCESS_SECRET: 'access',
      JWT_REFRESH_SECRET: 'refresh',
      JWT_ACCESS_EXPIRES: '15m',
      JWT_REFRESH_EXPIRES: '1d',
    };
    const config = {
      getOrThrow: (key: string) => values[key],
      get: (key: string, fallback?: string) => values[key] ?? fallback,
    } as unknown as ConfigService;
    const service = new AuthTokenService(new JwtService({}), config);
    const pair = await service.issueTokenPair('user-1', 'session-1');
    const jwt = new JwtService({});
    for (const token of [pair.accessToken, pair.refreshToken]) {
      const payload = jwt.decode<{ iss?: string; aud?: string }>(token);
      expect(payload?.iss).toBe('businesspaddi-api');
      expect(payload?.aud).toBe('businesspaddi-web');
    }
  });
});
