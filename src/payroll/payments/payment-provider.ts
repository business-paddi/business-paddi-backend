export type Beneficiary = {
  lineItemId: string;
  employeeId: string | null;
  recipientType: 'EMPLOYEE' | 'PLATFORM_FEE';
  name: string;
  bankCode: string;
  account: string;
  accountLast4?: string;
  amountKobo: string;
};
export type PaymentSnapshot = {
  version: 1;
  batchRevision: number;
  providerBinding?: string;
  period: string;
  currency: 'NGN';
  payerName: string;
  payerEmail: string;
  payerPhone: string;
  totalNetSalaryKobo: string;
  platformFeeKobo: string;
  providerFeeKobo: null;
  totalInvoiceKobo: string;
  beneficiaries: Beneficiary[];
};
export type InvoiceInput = {
  reference: string;
  rrr: string | null;
  snapshot: PaymentSnapshot;
  scenario: string;
};
export type InvoiceStatus = {
  rrr: string | null;
  reference: string;
  amountKobo: string | null;
  collection: 'UNPAID' | 'PAID' | 'FAILED' | 'UNKNOWN' | 'REVERSED';
  settlement: 'UNKNOWN' | 'PARTIAL' | 'SETTLED' | 'REVERSED';
  code: string;
  recipientEvidence: { lineItemId: string; status: 'PAID' | 'REVERSED' }[];
  simulation: boolean;
};
export interface PayrollPaymentProvider {
  createInvoice(input: InvoiceInput): Promise<{ rrr: string }>;
  getInvoiceStatus(input: InvoiceInput): Promise<InvoiceStatus>;
  verifyPayment(input: InvoiceInput): Promise<InvoiceStatus>;
  cancelUnpaidInvoice(input: InvoiceInput): Promise<void>;
}
