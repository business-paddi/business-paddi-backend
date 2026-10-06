type Environment = Record<string, string | undefined>;

const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'VERIFICATION_CODE_PEPPER',
  'RESEND_KEY',
  'RESEND_FROM_EMAIL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_EXPIRES',
  'JWT_REFRESH_EXPIRES',
  'GOOGLE_REDIRECT_URL',
] as const;

export function validateEnvironment(input: Environment): Environment {
  const environment = { ...input };
  for (const key of REQUIRED) requireValue(environment, key);
  if (!environment.GOOGLE_CLIENT_ID && !environment.CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID is required');
  }
  if (!environment.GOOGLE_CLIENT_SECRET && !environment.CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_SECRET is required');
  }
  validateUrl(environment.DATABASE_URL, 'DATABASE_URL');
  validateUrl(environment.REDIS_URL, 'REDIS_URL');
  validateUrl(environment.GOOGLE_REDIRECT_URL, 'GOOGLE_REDIRECT_URL');
  if (environment.FRONTEND_URL)
    validateUrl(environment.FRONTEND_URL, 'FRONTEND_URL');

  if (environment.NODE_ENV === 'production') {
    requireValue(environment, 'FRONTEND_URL');
    requireValue(environment, 'TRUST_PROXY');
    if (environment.COOKIE_SECURE !== 'true') {
      throw new Error('COOKIE_SECURE must be true in production');
    }
    for (const key of [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'VERIFICATION_CODE_PEPPER',
      'AUDIT_LOG_PEPPER',
      'RATE_LIMIT_PEPPER',
    ]) {
      const value = requireValue(environment, key);
      if (value.length < 32)
        throw new Error(`${key} must be at least 32 characters`);
    }
  }
  return environment;
}

function requireValue(environment: Environment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function validateUrl(value: string | undefined, key: string): void {
  try {
    if (!value) throw new Error();
    new URL(value);
  } catch {
    throw new Error(`${key} must be a valid absolute URL`);
  }
}
