import { validateRemitaEnvironment } from './remita-config';
import { createHash } from 'node:crypto';
import { fail } from '../payroll-calculation';
import { koboToNaira, nairaToKobo, validateSnapshot } from './payment-rules';
import type {
  InvoiceInput,
  InvoiceStatus,
  PayrollPaymentProvider,
} from './payment-provider';
import type { RemitaEnvironment } from './remita-config';

export const remitaSignature = (...parts: string[]) =>
  createHash('sha512').update(parts.join('')).digest('hex');

export function parseRemitaResponse(text: string): Record<string, unknown> {
  const literal = text.trim().replace(/^jsonp\s*\(\s*([\s\S]*)\)\s*;?$/, '$1');
  const value: unknown = JSON.parse(literal);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid provider response');
  return value as Record<string, unknown>;
}

export class RemitaSandboxProvider implements PayrollPaymentProvider {
  constructor(
    private readonly env: RemitaEnvironment,
    private readonly transport: typeof fetch = fetch,
  ) {
    validateRemitaEnvironment(env);
    if (env.PAYROLL_PROVIDER !== 'remita' || env.REMITA_MODE !== 'sandbox')
      throw new Error('Sandbox adapter requires sandbox configuration');
  }
  private async request(path: string, hash: string, body?: unknown) {
    try {
      const response = await this.transport(
        `${this.env.REMITA_BASE_URL}/${path}`,
        {
          method: body ? 'POST' : 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `remitaConsumerKey=${this.env.REMITA_MERCHANT_ID},remitaConsumerToken=${hash}`,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const text = await response.text();
      if (!response.ok || text.length > 65536)
        fail('REMITA_PROVIDER_UNAVAILABLE', 502);
      return parseRemitaResponse(text);
    } catch {
      fail('REMITA_PROVIDER_UNAVAILABLE', 503);
    }
  }
  async createInvoice(input: InvoiceInput) {
    if (this.env.REMITA_SANDBOX_SPLIT_APPROVED !== 'true')
      fail('REMITA_SPLIT_ONBOARDING_BLOCKED', 409);
    validateSnapshot(input.snapshot);
    const fixtures = new Set(
      this.env.REMITA_SANDBOX_FIXTURE_ACCOUNTS?.split(','),
    );
    if (
      input.snapshot.beneficiaries.some(
        (b) => !fixtures.has(`${b.bankCode}:${b.account}`),
      )
    )
      fail('UNAPPROVED_SANDBOX_BENEFICIARY', 422);
    const amount = koboToNaira(input.snapshot.totalInvoiceKobo);
    const body = await this.request(
      'merchant/api/paymentinit',
      remitaSignature(
        this.env.REMITA_MERCHANT_ID!,
        this.env.REMITA_SERVICE_TYPE_ID!,
        input.reference,
        amount,
        this.env.REMITA_API_KEY!,
      ),
      {
        serviceTypeId: this.env.REMITA_SERVICE_TYPE_ID,
        amount,
        orderId: input.reference,
        payerName: input.snapshot.payerName,
        payerEmail: input.snapshot.payerEmail,
        payerPhone: input.snapshot.payerPhone,
        description: `Approved payroll ${input.snapshot.period}`,
        lineItems: input.snapshot.beneficiaries.map((b) => ({
          lineItemsId: b.lineItemId,
          beneficiaryName: b.name,
          beneficiaryAccount: b.account,
          bankCode: b.bankCode,
          beneficiaryAmount: koboToNaira(b.amountKobo),
          deductFeeFrom: b.recipientType === 'PLATFORM_FEE' ? '1' : '0',
        })),
      },
    );
    if (
      body.statuscode !== '025' ||
      typeof body.RRR !== 'string' ||
      !/^\d{6,30}$/.test(body.RRR)
    )
      fail('REMITA_INVOICE_OUTCOME_UNKNOWN', 502);
    return { rrr: body.RRR };
  }
  async getInvoiceStatus(input: InvoiceInput): Promise<InvoiceStatus> {
    const reference = input.rrr ?? input.reference;
    const hash = remitaSignature(
      reference,
      this.env.REMITA_API_KEY!,
      this.env.REMITA_MERCHANT_ID!,
    );
    const body = await this.request(
      `${encodeURIComponent(this.env.REMITA_MERCHANT_ID!)}/${encodeURIComponent(reference)}/${hash}/${input.rrr ? 'status.reg' : 'orderstatus.reg'}`,
      hash,
    );
    let amount: string | null = null;
    if (
      typeof body.amount === 'string' ||
      (typeof body.amount === 'number' &&
        Number.isFinite(body.amount) &&
        body.amount <= Number.MAX_SAFE_INTEGER / 100)
    ) {
      try {
        amount = nairaToKobo(String(body.amount)).toString();
      } catch {
        /* Unverifiable amount remains unknown. */
      }
    }
    const code =
      typeof body.status === 'string' && /^[0-9]{2,3}$/.test(body.status)
        ? body.status
        : 'UNKNOWN';
    const rrr =
      typeof body.RRR === 'string' && /^\d{6,30}$/.test(body.RRR)
        ? body.RRR
        : null;
    return {
      rrr,
      reference: typeof body.orderId === 'string' ? body.orderId : '',
      amountKobo: amount,
      collection: ['00', '01'].includes(code)
        ? 'PAID'
        : code === '021'
          ? 'UNPAID'
          : code === '02'
            ? 'FAILED'
            : 'UNKNOWN',
      settlement: 'UNKNOWN',
      code,
      recipientEvidence: [],
      simulation: false,
    };
  }
  verifyPayment(input: InvoiceInput) {
    return this.getInvoiceStatus(input);
  }
  async cancelUnpaidInvoice(input: InvoiceInput) {
    if (!input.rrr) fail('RRR_REQUIRED', 409);
    const state = await this.verifyPayment(input);
    if (
      state.collection !== 'UNPAID' ||
      state.reference !== input.reference ||
      state.rrr !== input.rrr ||
      state.amountKobo !== input.snapshot.totalInvoiceKobo
    )
      fail('INVOICE_NOT_VERIFIED_UNPAID', 409);
    const hash = remitaSignature(
      input.rrr,
      this.env.REMITA_API_KEY!,
      this.env.REMITA_MERCHANT_ID!,
    );
    const body = await this.request('v2/api/deactivate.json', hash, {
      rrr: input.rrr,
      merchantId: this.env.REMITA_MERCHANT_ID,
      hash,
    });
    if (body.statuscode !== '00') fail('REMITA_CANCELLATION_UNKNOWN', 502);
  }
}
