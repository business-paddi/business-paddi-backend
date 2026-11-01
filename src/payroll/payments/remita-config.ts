import { fail } from '../payroll-calculation';

export type RemitaEnvironment = Record<string, string | undefined>;
export function validateRemitaEnvironment(env: RemitaEnvironment) {
  const provider = env.PAYROLL_PROVIDER ?? 'disabled';
  if (!['disabled', 'remita'].includes(provider))
    throw new Error('Invalid PAYROLL_PROVIDER');
  const mode = env.REMITA_MODE ?? 'mock';
  if (!['mock', 'sandbox'].includes(mode))
    throw new Error('REMITA_MODE must be mock or sandbox; live is unavailable');
  for (const flag of [
    'REMITA_SANDBOX_SPLIT_APPROVED',
    'REMITA_RECONCILER_ENABLED',
  ])
    if (env[flag] && !['true', 'false'].includes(env[flag]))
      throw new Error(flag + ' must be true or false');
  if (provider === 'disabled') return;
  if (env.NODE_ENV === 'production')
    throw new Error('Remita payroll proof of concept cannot run in production');
  const key = env.PAYROLL_ENCRYPTION_KEY ?? '';
  if (
    Buffer.from(key, 'base64').length !== 32 ||
    Buffer.from(key, 'base64').toString('base64') !== key
  )
    throw new Error('PAYROLL_ENCRYPTION_KEY required for Remita payroll');
  if (
    !/^\d{1,12}$/.test(env.PAYROLL_PLATFORM_FEE_KOBO ?? '10000') ||
    BigInt(env.PAYROLL_PLATFORM_FEE_KOBO ?? '10000') < 1n
  )
    throw new Error('Invalid PAYROLL_PLATFORM_FEE_KOBO');
  if (mode === 'mock') {
    if (
      env.REMITA_API_KEY ||
      env.REMITA_MERCHANT_ID ||
      env.REMITA_SERVICE_TYPE_ID ||
      env.REMITA_BASE_URL
    )
      throw new Error(
        'Mock mode must not contain Remita credentials or a provider URL',
      );
    return;
  }
  if (
    env.REMITA_BASE_URL !==
    'https://demo.remita.net/remita/exapp/api/v1/send/api/echannelsvc'
  )
    throw new Error('REMITA_BASE_URL must be the pinned official sandbox root');
  if (env.REMITA_CREDENTIAL_ENV !== 'sandbox')
    throw new Error(
      'Sandbox credential provenance must be explicitly confirmed',
    );
  for (const field of [
    'REMITA_MERCHANT_ID',
    'REMITA_SERVICE_TYPE_ID',
    'REMITA_API_KEY',
    'PAYROLL_PLATFORM_BANK_CODE',
    'PAYROLL_PLATFORM_ACCOUNT_NUMBER',
    'PAYROLL_PLATFORM_BENEFICIARY_NAME',
    'REMITA_SANDBOX_FIXTURE_ACCOUNTS',
  ])
    if (!env[field]?.trim())
      throw new Error(`${field} is required in sandbox mode`);
  if (
    !/^\d+$/.test(env.REMITA_MERCHANT_ID!) ||
    !/^\d+$/.test(env.REMITA_SERVICE_TYPE_ID!) ||
    /(?:sk_live|production)/i.test(env.REMITA_API_KEY!)
  )
    throw new Error('Invalid sandbox credentials');
  if (
    !/^\d{3,6}$/.test(env.PAYROLL_PLATFORM_BANK_CODE!) ||
    !/^\d{10}$/.test(env.PAYROLL_PLATFORM_ACCOUNT_NUMBER!)
  )
    throw new Error('Invalid platform beneficiary');
  if (
    !/^\d{3,6}:\d{10}(?:,\d{3,6}:\d{10})*$/.test(
      env.REMITA_SANDBOX_FIXTURE_ACCOUNTS!,
    )
  )
    throw new Error('Invalid approved sandbox fixture list');
}

export function enabled(env: RemitaEnvironment) {
  if (env.PAYROLL_PROVIDER !== 'remita') fail('PAYROLL_PROVIDER_DISABLED', 503);
  validateRemitaEnvironment(env);
  return env.REMITA_MODE === 'sandbox' ? 'sandbox' : 'mock';
}
