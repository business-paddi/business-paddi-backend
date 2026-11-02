import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { validateRemitaEnvironment } from './remita-config';
import { RemitaRuntime } from './remita-runtime';
import {
  digestPayment,
  koboToNaira,
  nairaToKobo,
  validateSnapshot,
} from './payment-rules';
import { MockPayrollProvider } from './mock-payroll.provider';
import {
  parseRemitaResponse,
  RemitaSandboxProvider,
  remitaSignature,
} from './remita-sandbox.provider';
import type { InvoiceInput, PaymentSnapshot } from './payment-provider';

function fixture(): InvoiceInput {
  const snapshot: PaymentSnapshot = {
    version: 1,
    batchRevision: 1,
    period: '2026-10-01/2026-10-31',
    currency: 'NGN',
    payerName: 'Synthetic Employer',
    payerEmail: 'payroll@example.test',
    payerPhone: '08000000000',
    totalNetSalaryKobo: '100001',
    platformFeeKobo: '10000',
    providerFeeKobo: null,
    totalInvoiceKobo: '110001',
    beneficiaries: [
      {
        lineItemId: 'salary-1',
        employeeId: 'synthetic-employee',
        recipientType: 'EMPLOYEE',
        name: 'Synthetic Employee',
        bankCode: '058',
        account: '0000000002',
        amountKobo: '100001',
      },
      {
        lineItemId: 'fee-1',
        employeeId: null,
        recipientType: 'PLATFORM_FEE',
        name: 'BusinessPaddi MOCK fee',
        bankCode: '058',
        account: '0000000001',
        amountKobo: '10000',
      },
    ],
  };
  return {
    reference: 'bp-test-reference',
    rrr: null,
    snapshot,
    scenario: 'UNPAID',
  };
}
const mockEnv = {
  PAYROLL_PROVIDER: 'remita',
  REMITA_MODE: 'mock',
  NODE_ENV: 'test',
  PAYROLL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};
const sandboxEnv = {
  ...mockEnv,
  REMITA_MODE: 'sandbox',
  REMITA_BASE_URL:
    'https://demo.remita.net/remita/exapp/api/v1/send/api/echannelsvc',
  REMITA_CREDENTIAL_ENV: 'sandbox',
  REMITA_MERCHANT_ID: '123456',
  REMITA_SERVICE_TYPE_ID: '654321',
  REMITA_API_KEY: 'test-only-not-a-provider-credential',
  PAYROLL_PLATFORM_BANK_CODE: '058',
  PAYROLL_PLATFORM_ACCOUNT_NUMBER: '0000000001',
  PAYROLL_PLATFORM_BENEFICIARY_NAME: 'Synthetic Vendor',
  REMITA_SANDBOX_FIXTURE_ACCOUNTS: '058:0000000001,058:0000000002',
  REMITA_SANDBOX_SPLIT_APPROVED: 'true',
};

describe('payroll instruction rules', () => {
  it('keeps snapshot hashes stable when JSONB reorders object keys', () => {
    expect(digestPayment({ a: 1, b: { x: 2, y: 3 } })).toBe(
      digestPayment({ b: { y: 3, x: 2 }, a: 1 }),
    );
  });
  it('keeps naira/kobo arithmetic exact above JavaScript safe integer precision', () => {
    expect(nairaToKobo('90071992547409.93')).toBe(9007199254740993n);
    expect(koboToNaira('9007199254740993')).toBe('90071992547409.93');
    expect(nairaToKobo('0.01')).toBe(1n);
    expect(() => nairaToKobo('1.001')).toThrow();
    expect(() => nairaToKobo('1e6')).toThrow();
  });
  it('validates an explicit vendor fee and exact salary/invoice totals', () => {
    expect(() => validateSnapshot(fixture().snapshot)).not.toThrow();
    const wrong = fixture();
    wrong.snapshot.totalInvoiceKobo = '100001';
    expect(() => validateSnapshot(wrong.snapshot)).toThrow();
    const salaryFee = fixture();
    salaryFee.snapshot.beneficiaries[1].recipientType = 'EMPLOYEE';
    expect(() => validateSnapshot(salaryFee.snapshot)).toThrow();
  });
  it('rejects duplicate beneficiaries, duplicate employees and invalid bank details', () => {
    for (const change of [
      'account',
      'bank',
      'amount',
      'duplicate',
      'employee',
    ] as const) {
      const f = fixture(),
        b = f.snapshot.beneficiaries[0];
      if (change === 'account') b.account = '123';
      if (change === 'bank') b.bankCode = 'ABC';
      if (change === 'amount') b.amountKobo = '1.1';
      if (change === 'duplicate')
        f.snapshot.beneficiaries[1].account = b.account;
      if (change === 'employee')
        f.snapshot.beneficiaries.push({
          ...b,
          lineItemId: 'different',
          account: '0000000003',
        });
      expect(() => validateSnapshot(f.snapshot)).toThrow();
    }
  });
  it('rejects live/production settings, missing encryption and production or redirect hosts', () => {
    expect(() => validateRemitaEnvironment(mockEnv)).not.toThrow();
    expect(() => validateRemitaEnvironment(sandboxEnv)).not.toThrow();
    for (const env of [
      { ...mockEnv, REMITA_MODE: 'live' },
      { ...mockEnv, NODE_ENV: 'production' },
      { ...mockEnv, PAYROLL_ENCRYPTION_KEY: '' },
      { ...mockEnv, REMITA_API_KEY: 'accidental-key' },
      { ...sandboxEnv, REMITA_BASE_URL: 'https://www.remita.net' },
      {
        ...sandboxEnv,
        REMITA_BASE_URL: sandboxEnv.REMITA_BASE_URL + '?redirect=evil',
      },
      { ...sandboxEnv, REMITA_CREDENTIAL_ENV: 'production' },
    ])
      expect(() => validateRemitaEnvironment(env)).toThrow();
    expect(() => new RemitaRuntime(new ConfigService({})).provider()).toThrow();
  });
  it('requires explicit split onboarding before generating sandbox invoices', async () => {
    const adapter = new RemitaSandboxProvider({
      ...sandboxEnv,
      REMITA_SANDBOX_SPLIT_APPROVED: 'false',
    });
    await expect(adapter.createInvoice(fixture())).rejects.toThrow();
  });
});

describe('deterministic offline mock', () => {
  const mock = new MockPayrollProvider();
  it('returns fake stable invoices and unpaid status without credentials or network', async () => {
    const first = await mock.createInvoice(fixture());
    expect(first.rrr).toMatch(/^MOCK-/);
    expect(await mock.createInvoice(fixture())).toEqual(first);
    expect((await mock.verifyPayment(fixture())).collection).toBe('UNPAID');
  });
  it('keeps paid collection separate from simulated recipient settlement and supports reversals', async () => {
    const f = fixture();
    f.scenario = 'PAID';
    expect(await mock.verifyPayment(f)).toMatchObject({
      collection: 'PAID',
      settlement: 'UNKNOWN',
      recipientEvidence: [],
      simulation: true,
    });
    f.scenario = 'PARTIAL';
    expect(await mock.verifyPayment(f)).toMatchObject({
      collection: 'PAID',
      settlement: 'PARTIAL',
      recipientEvidence: [{ lineItemId: 'salary-1', status: 'PAID' }],
    });
    f.scenario = 'REVERSED';
    expect(await mock.verifyPayment(f)).toMatchObject({
      collection: 'REVERSED',
      settlement: 'REVERSED',
    });
    f.scenario = 'FAILED';
    expect((await mock.verifyPayment(f)).collection).toBe('FAILED');
  });
  it('does not hide simulated errors or allow cancellation after collection', async () => {
    const f = fixture();
    f.scenario = 'TIMEOUT';
    await expect(mock.createInvoice(f)).rejects.toThrow();
    f.scenario = 'ERROR';
    await expect(mock.verifyPayment(f)).rejects.toThrow();
    f.scenario = 'PAID';
    await expect(mock.cancelUnpaidInvoice(f)).rejects.toThrow();
    f.scenario = 'UNDERPAID';
    expect((await mock.verifyPayment(f)).amountKobo).toBe('110000');
  });
});

describe('Remita sandbox wire contract against a local HTTP simulation', () => {
  let server: Server, origin: string;
  let scenario = 'invoice';
  const requests: {
    path: string;
    authorization: string | undefined;
    body: Record<string, unknown> | null;
  }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (b: Buffer) => chunks.push(b));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        requests.push({
          path: req.url!,
          authorization: req.headers.authorization,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
        });
        if (scenario === 'delay') {
          setTimeout(() => {
            res.end('{}');
          }, 150);
          return;
        }
        if (scenario === 'error') {
          res.statusCode = 503;
          res.end('<html>Unavailable</html>');
          return;
        }
        if (req.url?.endsWith('paymentinit')) {
          res.end(
            'jsonp ({"statuscode":"025","RRR":"123456789012","status":"Payment Reference generated"})',
          );
          return;
        }
        if (req.url?.endsWith('deactivate.json')) {
          res.end('{"statuscode":"00","status":"Successful"}');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            RRR: '123456789012',
            orderId: 'bp-test-reference',
            amount: 1100.01,
            status:
              scenario === 'paid'
                ? '00'
                : scenario === 'unknown'
                  ? '999'
                  : '021',
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('Missing local listener');
    origin = 'http://127.0.0.1:' + address.port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    scenario = 'invoice';
    requests.length = 0;
  });
  const transport: typeof fetch = (url, init) =>
    fetch(
      origin + new URL(String(url)).pathname,
      init as RequestInit | undefined,
    );

  it('uses a known SHA-512 vector and never evaluates JSONP', () => {
    expect(remitaSignature('a', 'b', 'c')).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
    expect(() => parseRemitaResponse('jsonp (process.exit())')).toThrow();
  });
  it('serializes the documented invoice body, preserves bank zeroes and allocates provider fees to the vendor', async () => {
    const adapter = new RemitaSandboxProvider(sandboxEnv, transport);
    expect(await adapter.createInvoice(fixture())).toEqual({
      rrr: '123456789012',
    });
    const request = requests[0];
    const hash = createHash('sha512')
      .update(
        '123456654321bp-test-reference1100.01test-only-not-a-provider-credential',
      )
      .digest('hex');
    expect(request.authorization).toBe(
      'remitaConsumerKey=123456,remitaConsumerToken=' + hash,
    );
    expect(request.path).toBe(
      '/remita/exapp/api/v1/send/api/echannelsvc/merchant/api/paymentinit',
    );
    expect(request.body).toMatchObject({
      amount: '1100.01',
      serviceTypeId: '654321',
      orderId: 'bp-test-reference',
      lineItems: [
        {
          lineItemsId: 'salary-1',
          bankCode: '058',
          beneficiaryAccount: '0000000002',
          beneficiaryAmount: '1000.01',
          deductFeeFrom: '0',
        },
        {
          lineItemsId: 'fee-1',
          beneficiaryAmount: '100.00',
          deductFeeFrom: '1',
        },
      ],
    });
  });
  it('verifies by RRR or by order reference with the distinct documented status signatures', async () => {
    const adapter = new RemitaSandboxProvider(sandboxEnv, transport),
      f = fixture();
    scenario = 'paid';
    expect(await adapter.verifyPayment(f)).toMatchObject({
      collection: 'PAID',
      amountKobo: '110001',
      settlement: 'UNKNOWN',
      recipientEvidence: [],
      simulation: false,
    });
    expect(requests[0].path).toContain('/orderstatus.reg');
    f.rrr = '123456789012';
    await adapter.verifyPayment(f);
    expect(requests[1].path).toContain(
      remitaSignature('123456789012', sandboxEnv.REMITA_API_KEY, '123456') +
        '/status.reg',
    );
  });
  it('checks unpaid status before cancellation and sends the documented cancellation body', async () => {
    const adapter = new RemitaSandboxProvider(sandboxEnv, transport),
      f = fixture();
    f.rrr = '123456789012';
    await adapter.cancelUnpaidInvoice(f);
    expect(requests[1].body).toEqual({
      rrr: '123456789012',
      merchantId: '123456',
      hash: remitaSignature(
        '123456789012',
        sandboxEnv.REMITA_API_KEY,
        '123456',
      ),
    });
    scenario = 'paid';
    await expect(adapter.cancelUnpaidInvoice(f)).rejects.toThrow();
  });
  it('treats unknown responses, upstream failure and actual HTTP timeout conservatively', async () => {
    const adapter = new RemitaSandboxProvider(sandboxEnv, transport);
    scenario = 'unknown';
    expect((await adapter.verifyPayment(fixture())).collection).toBe('UNKNOWN');
    scenario = 'error';
    await expect(adapter.verifyPayment(fixture())).rejects.toThrow();
    scenario = 'delay';
    const short: typeof fetch = (url, init) =>
      fetch(origin + new URL(String(url)).pathname, {
        ...(init as RequestInit | undefined),
        signal: AbortSignal.timeout(25),
      });
    await expect(
      new RemitaSandboxProvider(sandboxEnv, short).verifyPayment(fixture()),
    ).rejects.toThrow();
  });
});
