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
  if (environment.TASK_PUBLIC_API_URL) {
    validateUrl(environment.TASK_PUBLIC_API_URL, 'TASK_PUBLIC_API_URL');
    const origin = new URL(environment.TASK_PUBLIC_API_URL);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/'
    )
      throw new Error('TASK_PUBLIC_API_URL must be an HTTP(S) origin');
    if (environment.NODE_ENV === 'production' && origin.protocol !== 'https:')
      throw new Error('TASK_PUBLIC_API_URL must use HTTPS in production');
  }
  if (
    environment.INVITE_EMAIL_ENABLED &&
    !['true', 'false'].includes(environment.INVITE_EMAIL_ENABLED)
  )
    throw new Error('INVITE_EMAIL_ENABLED must be true or false');
  if (
    environment.INVITE_FRONTEND_PATH &&
    (!environment.INVITE_FRONTEND_PATH.startsWith('/') ||
      environment.INVITE_FRONTEND_PATH.startsWith('//') ||
      /[?#\\]/.test(environment.INVITE_FRONTEND_PATH))
  )
    throw new Error(
      'INVITE_FRONTEND_PATH must be an absolute path on FRONTEND_URL without a query or fragment',
    );
  if (environment.PAYROLL_ENCRYPTION_KEY) {
    const key = Buffer.from(environment.PAYROLL_ENCRYPTION_KEY, 'base64');
    if (
      key.length !== 32 ||
      key.toString('base64') !== environment.PAYROLL_ENCRYPTION_KEY
    ) {
      throw new Error(
        'PAYROLL_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key',
      );
    }
  }

  if (environment.NODE_ENV === 'production') {
    if (
      environment.CLOUDINARY_CLOUD_NAME ||
      environment.CLOUDINARY_API_KEY ||
      environment.CLOUDINARY_API_SECRET
    )
      requireValue(environment, 'TASK_PUBLIC_API_URL');
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
