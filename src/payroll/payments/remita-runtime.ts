import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { enabled, type RemitaEnvironment } from './remita-config';
import { MockPayrollProvider } from './mock-payroll.provider';
import { RemitaSandboxProvider } from './remita-sandbox.provider';
import type { PayrollPaymentProvider } from './payment-provider';
import { fail } from '../payroll-calculation';
const KEYS = [
  'NODE_ENV',
  'PAYROLL_PROVIDER',
  'REMITA_MODE',
  'PAYROLL_ENCRYPTION_KEY',
  'PAYROLL_PLATFORM_FEE_KOBO',
  'PAYROLL_PLATFORM_BANK_CODE',
  'PAYROLL_PLATFORM_ACCOUNT_NUMBER',
  'PAYROLL_PLATFORM_BENEFICIARY_NAME',
  'REMITA_BASE_URL',
  'REMITA_CREDENTIAL_ENV',
  'REMITA_MERCHANT_ID',
  'REMITA_SERVICE_TYPE_ID',
  'REMITA_API_KEY',
  'REMITA_SANDBOX_FIXTURE_ACCOUNTS',
  'REMITA_SANDBOX_SPLIT_APPROVED',
  'REMITA_RECONCILER_ENABLED',
];
@Injectable()
export class RemitaRuntime {
  constructor(private readonly config: ConfigService) {}
  environment(): RemitaEnvironment {
    return Object.fromEntries(KEYS.map((k) => [k, this.config.get<string>(k)]));
  }
  mode() {
    return enabled(this.environment());
  }
  provider(): PayrollPaymentProvider {
    return this.mode() === 'mock'
      ? new MockPayrollProvider()
      : new RemitaSandboxProvider(this.environment());
  }
  assertInvoiceEnabled() {
    if (
      this.mode() === 'sandbox' &&
      this.environment().REMITA_SANDBOX_SPLIT_APPROVED !== 'true'
    )
      fail('REMITA_SPLIT_ONBOARDING_BLOCKED', 409);
  }
}
