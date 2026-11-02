import { createHash } from 'node:crypto';
import { fail } from '../payroll-calculation';
import type {
  InvoiceInput,
  InvoiceStatus,
  PayrollPaymentProvider,
} from './payment-provider';
export const MOCK_SCENARIOS = [
  'UNPAID',
  'PAID',
  'FAILED',
  'PARTIAL',
  'SETTLED',
  'REVERSED',
  'UNDERPAID',
  'TIMEOUT',
  'ERROR',
] as const;

export class MockPayrollProvider implements PayrollPaymentProvider {
  async createInvoice(input: InvoiceInput) {
    this.failure(input);
    return await Promise.resolve({
      rrr:
        'MOCK-' +
        createHash('sha256').update(input.reference).digest('hex').slice(0, 20),
    });
  }
  private failure(input: InvoiceInput) {
    if (input.scenario === 'TIMEOUT') fail('MOCK_PROVIDER_TIMEOUT', 503);
    if (input.scenario === 'ERROR') fail('MOCK_PROVIDER_ERROR', 502);
  }
  async getInvoiceStatus(input: InvoiceInput): Promise<InvoiceStatus> {
    this.failure(input);
    const { rrr } = await this.createInvoice(input);
    const paid = ['PAID', 'PARTIAL', 'SETTLED', 'UNDERPAID'].includes(
      input.scenario,
    );
    const employees = input.snapshot.beneficiaries.filter(
      (b) => b.recipientType === 'EMPLOYEE',
    );
    const evidence =
      input.scenario === 'PARTIAL'
        ? employees.slice(0, 1)
        : input.scenario === 'SETTLED' || input.scenario === 'REVERSED'
          ? input.snapshot.beneficiaries
          : [];
    return {
      rrr,
      reference: input.reference,
      amountKobo:
        input.scenario === 'UNDERPAID'
          ? (BigInt(input.snapshot.totalInvoiceKobo) - 1n).toString()
          : input.snapshot.totalInvoiceKobo,
      collection:
        input.scenario === 'REVERSED'
          ? 'REVERSED'
          : paid
            ? 'PAID'
            : input.scenario === 'FAILED'
              ? 'FAILED'
              : 'UNPAID',
      settlement:
        input.scenario === 'PARTIAL'
          ? 'PARTIAL'
          : input.scenario === 'SETTLED'
            ? 'SETTLED'
            : input.scenario === 'REVERSED'
              ? 'REVERSED'
              : 'UNKNOWN',
      code: 'MOCK_' + input.scenario,
      recipientEvidence: evidence.map((b) => ({
        lineItemId: b.lineItemId,
        status: input.scenario === 'REVERSED' ? 'REVERSED' : 'PAID',
      })),
      simulation: true,
    };
  }
  verifyPayment(input: InvoiceInput) {
    return this.getInvoiceStatus(input);
  }
  async cancelUnpaidInvoice(input: InvoiceInput) {
    this.failure(input);
    await this.getInvoiceStatus(input);
    if (input.scenario !== 'UNPAID') fail('INVOICE_NOT_UNPAID', 409);
  }
}
