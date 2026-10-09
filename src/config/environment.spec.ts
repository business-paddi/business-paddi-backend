import { validateEnvironment } from './environment';

const BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  VERIFICATION_CODE_PEPPER: 'a'.repeat(32),
  RESEND_KEY: 're_test',
  RESEND_FROM_EMAIL: 'Test <test@example.com>',
  JWT_ACCESS_SECRET: 'access',
  JWT_REFRESH_SECRET: 'refresh',
  JWT_ACCESS_EXPIRES: '15m',
  JWT_REFRESH_EXPIRES: '1d',
  GOOGLE_REDIRECT_URL: 'http://localhost:3001/api/auth/google/callback',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
};

describe('validateEnvironment', () => {
  it('validates an optional payroll encryption key without blocking lightweight registration', () => {
    expect(() =>
      validateEnvironment({
        ...BASE,
        PAYROLL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      }),
    ).not.toThrow();
    expect(() =>
      validateEnvironment({ ...BASE, PAYROLL_ENCRYPTION_KEY: 'invalid' }),
    ).toThrow('PAYROLL_ENCRYPTION_KEY');
  });
  it('accepts a complete development environment', () => {
    expect(() => validateEnvironment({ ...BASE })).not.toThrow();
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'VERIFICATION_CODE_PEPPER',
    'RESEND_KEY',
    'JWT_ACCESS_SECRET',
    'GOOGLE_REDIRECT_URL',
  ])('requires %p', (key: string) => {
    const input = { ...BASE, [key]: undefined };
    expect(() => validateEnvironment(input)).toThrow(`${key} is required`);
  });

  it('accepts CLIENT_ID/CLIENT_SECRET as Google fallbacks', () => {
    expect(() =>
      validateEnvironment({
        ...BASE,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        CLIENT_ID: 'id',
        CLIENT_SECRET: 'secret',
      }),
    ).not.toThrow();
  });

  it('rejects non-URL values', () => {
    expect(() =>
      validateEnvironment({ ...BASE, REDIS_URL: 'not-a-url' }),
    ).toThrow('REDIS_URL must be a valid absolute URL');
  });

  it('does not require any OIDC_* keys, even in production', () => {
    const input = {
      ...BASE,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://app.example.com',
      TRUST_PROXY: '1',
      COOKIE_SECURE: 'true',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      JWT_REFRESH_SECRET: 'y'.repeat(32),
      VERIFICATION_CODE_PEPPER: 'z'.repeat(32),
      AUDIT_LOG_PEPPER: 'a'.repeat(32),
      RATE_LIMIT_PEPPER: 'b'.repeat(32),
    };
    expect(() => validateEnvironment(input)).not.toThrow();
  });

  it('enforces production requirements', () => {
    expect(() =>
      validateEnvironment({ ...BASE, NODE_ENV: 'production' }),
    ).toThrow('FRONTEND_URL is required');
  });
});
