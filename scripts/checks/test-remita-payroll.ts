import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import {
  HttpException,
  NotFoundException,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaClient } from '../../generated/prisma/client';
import type { PrismaService } from '../../src/database/prisma.service';
import type { PayrollAccessService } from '../../src/payroll/payroll-access.service';
import type { AuthenticatedRateLimitService } from '../../src/rate-limit/authenticated-rate-limit.service';
import { encryptPayrollField } from '../../src/business-foundation/sensitive-fields';
import { PayrollPaymentService } from '../../src/payroll/payments/payroll-payment.service';
import {
  PayrollPaymentController,
  RemitaWebhookController,
} from '../../src/payroll/payments/payroll-payment.controller';
import { RemitaRuntime } from '../../src/payroll/payments/remita-runtime';
import { MockPayrollProvider } from '../../src/payroll/payments/mock-payroll.provider';
import { AccessTokenGuard } from '../../src/identity/auth-guard/access-token.guard';
import type {
  PayrollPaymentProvider,
  InvoiceInput,
} from '../../src/payroll/payments/payment-provider';
import { databaseErrorSummary } from '../lib/database-error';

async function main() {
  const schema = 'remita_test_' + randomBytes(8).toString('hex');
  assert.match(schema, /^remita_test_[a-f0-9]{16}$/);
  const uri = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL!);
  uri.hostname = uri.hostname.replace('-pooler.', '.');
  const admin = new Pool({
    connectionString: uri.toString(),
    max: 1,
    connectionTimeoutMillis: 15000,
  });
  let created = false,
    client: PrismaClient | undefined;
  let checks = 0;
  const check = (name: string, value: unknown) => {
    assert.ok(value, name);
    checks++;
    console.log('PASS: ' + name);
  };
  const reject = async (
    name: string,
    work: () => Promise<unknown>,
    status?: number,
  ) => {
    try {
      await work();
    } catch (error) {
      if (status)
        assert.equal(
          error instanceof HttpException ? error.getStatus() : 0,
          status,
        );
      check(name, true);
      return;
    }
    throw Error(name + ': expected rejection');
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await admin.query(`SET search_path TO "${schema}",public`);
    // Definitions only, no production rows and no real banking information.
    await admin.query(
      `CREATE TABLE "User" ("id" TEXT PRIMARY KEY); CREATE TABLE "Business" ("id" TEXT PRIMARY KEY); CREATE TABLE "PayrollBatch" (LIKE public."PayrollBatch" INCLUDING ALL); CREATE TABLE "PayrollRecipient" (LIKE public."PayrollRecipient" INCLUDING ALL); CREATE TABLE "AuditEvent" (LIKE public."AuditEvent" INCLUDING ALL); INSERT INTO "User" VALUES ('maker'),('reviewer'),('reader'); INSERT INTO "Business" VALUES ('b'),('foreign');`,
    );
    await admin.query(`CREATE TYPE "AuditCategory" AS ENUM ('authentication','account','session','security','business');
      CREATE TYPE "AuditOutcome" AS ENUM ('success','failure','blocked');
      CREATE TYPE "AuditSeverity" AS ENUM ('info','warning','error','critical');
      ALTER TABLE "AuditEvent" ALTER COLUMN "severity" DROP DEFAULT;
      ALTER TABLE "AuditEvent" ALTER COLUMN "category" TYPE "AuditCategory" USING "category"::text::"AuditCategory";
      ALTER TABLE "AuditEvent" ALTER COLUMN "outcome" TYPE "AuditOutcome" USING "outcome"::text::"AuditOutcome";
      ALTER TABLE "AuditEvent" ALTER COLUMN "severity" TYPE "AuditSeverity" USING "severity"::text::"AuditSeverity";
      ALTER TABLE "AuditEvent" ALTER COLUMN "severity" SET DEFAULT 'info'::"AuditSeverity";`);
    await admin.query(
      await readFile(
        'prisma/migrations/20261031190000_remita_payroll_instructions/migration.sql',
        'utf8',
      ),
    );
    client = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: uri.toString(),
          max: 6,
          connectionTimeoutMillis: 15000,
          options: `-c search_path=${schema},public`,
        },
        { schema },
      ),
    });
    const db = client;
    const key = Buffer.alloc(32, 7).toString('base64');
    const env = {
      NODE_ENV: 'test',
      PAYROLL_PROVIDER: 'remita',
      REMITA_MODE: 'mock',
      PAYROLL_ENCRYPTION_KEY: key,
      PAYROLL_PLATFORM_FEE_KOBO: '10000',
    };
    const runtime = new RemitaRuntime(new ConfigService(env));
    const permissions: Record<string, string[]> = {
      maker: [
        'payroll:view_details',
        'payments:create',
        'payments:approve',
        'invoices:create',
        'invoices:view',
        'payments:cancel',
      ],
      reviewer: ['payroll:view_details', 'payments:approve', 'invoices:view'],
      reader: ['invoices:view', 'payroll:view_details'],
      viewer: ['invoices:view'],
    };
    const access = {
      context: async (
        user: string,
        business: string,
        grants: string[] = [],
      ) => {
        if (business !== 'b' || !permissions[user])
          throw new NotFoundException('Business not found');
        if (grants.some((g) => !permissions[user].includes(g)))
          throw new ForbiddenException('Missing business permission');
        return { actor: { userId: user } };
      },
    } as unknown as PayrollAccessService;
    const limits = {
      consume: async () => undefined,
    } as unknown as AuthenticatedRateLimitService;
    const mock = new MockPayrollProvider();
    let creates = 0;
    const provider: PayrollPaymentProvider = {
      createInvoice: async (input) => {
        creates++;
        return mock.createInvoice(input);
      },
      getInvoiceStatus: (input) => mock.getInvoiceStatus(input),
      verifyPayment: (input) => mock.verifyPayment(input),
      cancelUnpaidInvoice: (input) => mock.cancelUnpaidInvoice(input),
    };
    runtime.provider = () => provider;
    const service = new PayrollPaymentService(
      db as unknown as PrismaService,
      access,
      runtime,
      limits,
    );
    async function batch(id: string, business = 'b') {
      await db.payrollBatch.create({
        data: {
          id,
          businessId: business,
          name: 'Synthetic local payroll ' + id,
          status: 'approved',
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          payDate: '2026-10-31',
          payFrequency: 'monthly',
          currency: 'NGN',
          createdBy: { userId: 'maker' },
          reviewedBy: { userId: 'reviewer' },
          contributorUserIds: ['maker'],
          approvedAt: new Date(),
          calculation: {
            calculationStatus: 'ready',
            totals: { netAmount: '2000.02' },
          },
        },
      });
      for (let i = 2; i <= 3; i++)
        await db.payrollRecipient.create({
          data: {
            id: `${id}-r${i}`,
            businessId: business,
            batchId: id,
            employeeId: `synthetic-${i}`,
            source: {
              employee: { fullName: 'Synthetic Employee ' + i },
              bank: {
                bankCode: '058',
                accountNumber: encryptPayrollField('000000000' + i, key),
                accountName: encryptPayrollField(
                  'Synthetic Employee ' + i,
                  key,
                ),
                verificationStatus: 'verified',
              },
            },
            sourceVersion: 'a'.repeat(64),
            calculation: {
              readiness: 'ready',
              totals: { netAmount: '1000.01' },
            },
          },
        });
    }
    await batch('one');
    const payer = {
      payerName: 'Synthetic Employer',
      payerEmail: 'payroll@example.test',
      payerPhone: '08000000000',
    };
    const draft = await service.prepare(
      'maker',
      'b',
      'one',
      payer,
      'request-one',
    );
    check(
      'exact integer-kobo totals and a separate vendor beneficiary',
      draft.totalNetSalaryKobo === '200002' &&
        draft.platformFeeKobo === '10000' &&
        draft.totalInvoiceKobo === '210002' &&
        draft.beneficiaries.filter((b) => b.recipientType === 'PLATFORM_FEE')
          .length === 1,
    );
    check(
      'bank accounts encrypted at rest and withheld from API responses',
      JSON.stringify(
        (await db.payrollPayment.findUniqueOrThrow({ where: { id: draft.id } }))
          .snapshot,
      ).includes('enc:v1:') && !JSON.stringify(draft).includes('0000000002'),
    );
    check(
      'prepare idempotency returns the same instruction',
      (await service.prepare('maker', 'b', 'one', payer, 'request-one')).id ===
        draft.id,
    );
    await reject(
      'changed request cannot reuse an idempotency key',
      () =>
        service.prepare(
          'maker',
          'b',
          'one',
          { ...payer, payerName: 'Changed' },
          'request-one',
        ),
      409,
    );
    await reject(
      'different request cannot duplicate an active payroll instruction',
      () => service.prepare('maker', 'b', 'one', payer, 'request-two'),
      409,
    );
    await reject(
      'cross-business lookups are denied',
      () => service.get('maker', 'foreign', draft.id),
      404,
    );
    await reject(
      'outsiders are denied',
      () => service.get('outsider', 'b', draft.id),
      404,
    );
    await reject(
      'invoice creation requires its separate permission',
      () => service.invoice('reader', 'b', draft.id),
      403,
    );
    await reject(
      'approval requires its separate permission',
      () => service.approve('reader', 'b', draft.id),
      403,
    );
    await reject(
      'creator and payroll contributor cannot approve payment',
      () => service.approve('maker', 'b', draft.id),
      403,
    );
    await service.approve('reviewer', 'b', draft.id);
    await reject(
      'general viewer cannot retrieve named salary lines',
      () => service.get('viewer', 'b', draft.id),
      403,
    );
    await reject('database rejects changing an approved snapshot', () =>
      db.payrollPayment.update({
        where: { id: draft.id },
        data: { snapshot: { tampered: true } },
      }),
    );
    await reject('database rejects changing approved totals', () =>
      db.payrollPayment.update({
        where: { id: draft.id },
        data: { totalInvoiceKobo: 1n },
      }),
    );
    await reject('database rejects changing approval metadata', () =>
      db.payrollPayment.update({
        where: { id: draft.id },
        data: { approvedByUserId: 'reader' },
      }),
    );
    const invoices = await Promise.all([
      service.invoice('maker', 'b', draft.id),
      service.invoice('maker', 'b', draft.id),
    ]);
    check(
      'concurrent invoice calls issue one provider creation only',
      creates === 1 && invoices.some((p) => p.remitaRRR?.startsWith('MOCK-')),
    );
    await service.invoice('maker', 'b', draft.id);
    check('subsequent invoice calls never create another RRR', creates === 1);
    check(
      'unpaid verification is not settlement',
      (await service.refresh('maker', 'b', draft.id)).providerStatus ===
        'UNPAID',
    );
    await service.mockEvent('maker', 'b', draft.id, {
      eventId: 'paid',
      scenario: 'PAID',
    });
    const paid = await service.refresh('maker', 'b', draft.id);
    check(
      'collection success does not mark salaries settled',
      paid.providerStatus === 'PAID' &&
        paid.settlementStatus === 'UNKNOWN' &&
        paid.beneficiaries.every((b) => b.status === 'UNKNOWN') &&
        paid.verifiedAt,
    );
    await service.mockEvent('maker', 'b', draft.id, {
      eventId: 'paid',
      scenario: 'PAID',
    });
    check(
      'mock event replay is deduplicated',
      (await db.payrollMockEvent.count({
        where: { paymentId: draft.id, eventId: 'paid' },
      })) === 1,
    );
    await reject(
      'event ID reuse with a different scenario is rejected',
      () =>
        service.mockEvent('maker', 'b', draft.id, {
          eventId: 'paid',
          scenario: 'FAILED',
        }),
      409,
    );
    await service.mockEvent('maker', 'b', draft.id, {
      eventId: 'partial',
      scenario: 'PARTIAL',
    });
    const partial = await service.refresh('maker', 'b', draft.id);
    check(
      'only evidenced mock recipients become paid during partial settlement',
      partial.settlementStatus === 'PARTIAL' &&
        partial.beneficiaries.filter((b) => b.status === 'PAID').length === 1,
    );
    await service.mockEvent('maker', 'b', draft.id, {
      eventId: 'underpaid',
      scenario: 'UNDERPAID',
    });
    const underpaid = await service.refresh('maker', 'b', draft.id);
    check(
      'underpayment fails amount verification and clears recipient success',
      underpaid.providerStatus === 'MISMATCH' &&
        underpaid.verifiedAt === null &&
        underpaid.beneficiaries.every((b) => b.status === 'UNKNOWN'),
    );
    const originalVerify = provider.verifyPayment;
    provider.verifyPayment = async (input: InvoiceInput) => ({
      ...(await mock.verifyPayment({ ...input, scenario: 'PAID' })),
      reference: 'wrong-order',
    });
    const wrongOrder = await service.refresh('maker', 'b', draft.id);
    check(
      'a paid response for another merchant reference is not accepted',
      wrongOrder.providerStatus === 'MISMATCH' &&
        wrongOrder.verifiedAt === null,
    );
    provider.verifyPayment = originalVerify;
    await service.mockEvent('maker', 'b', draft.id, {
      eventId: 'reverse',
      scenario: 'REVERSED',
    });
    const reverse = await service.refresh('maker', 'b', draft.id);
    check(
      'simulated reversals are not reported as salary success',
      reverse.providerStatus === 'REVERSED' &&
        reverse.beneficiaries.every((b) => b.status === 'REVERSED'),
    );
    await service.mockEvent('maker', 'b', draft.id, {
      eventId: 'failed',
      scenario: 'FAILED',
    });
    check(
      'failed collection is not settled',
      (await service.refresh('maker', 'b', draft.id)).providerStatus ===
        'FAILED',
    );
    await service.mockEvent('maker', 'b', draft.id, {
      eventId: 'unavailable',
      scenario: 'ERROR',
    });
    const unavailable = await service.refresh('maker', 'b', draft.id);
    check(
      'unknown provider failure remains retryable with no invented success',
      unavailable.lastErrorCode === 'PROVIDER_STATUS_UNAVAILABLE',
    );

    await batch('timeout');
    const timed = await service.prepare(
      'maker',
      'b',
      'timeout',
      payer,
      'request-timeout',
    );
    await service.mockEvent('maker', 'b', timed.id, {
      eventId: 'delay',
      scenario: 'TIMEOUT',
    });
    await service.approve('reviewer', 'b', timed.id);
    const countBefore = creates;
    const unknown = await service.invoice('maker', 'b', timed.id);
    await service.invoice('maker', 'b', timed.id);
    check(
      'ambiguous invoice timeouts are durably recorded and never blindly retried',
      unknown.state === 'INVOICE_UNKNOWN' && creates === countBefore + 1,
    );
    await service.mockEvent('maker', 'b', timed.id, {
      eventId: 'recover',
      scenario: 'UNPAID',
    });
    const recovered = await service.refresh('maker', 'b', timed.id);
    check(
      'recovery uses the original order reference without another create',
      recovered.state === 'INVOICE_READY' &&
        creates === countBefore + 1 &&
        recovered.remitaRRR?.startsWith('MOCK-'),
    );
    await service.cancel('maker', 'b', timed.id);
    check(
      'unpaid mock cancellation preserves the audit record',
      (await service.get('maker', 'b', timed.id)).state === 'CANCELLED',
    );
    await reject('database prevents deletion of a cancelled payment', () =>
      db.payrollPayment.delete({ where: { id: timed.id } }),
    );

    // Exercise actual HTTP routing/validation locally. Test-only principals replace session authentication;
    // tenant permission checks still run in PayrollPaymentService.
    const module = await Test.createTestingModule({
      controllers: [PayrollPaymentController, RemitaWebhookController],
      providers: [{ provide: PayrollPaymentService, useValue: service }],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => {
            getRequest: () => {
              headers: Record<string, string>;
              auth?: { userId: string };
            };
          };
        }) => {
          const r = ctx.switchToHttp().getRequest();
          if (!r.headers['x-test-user'])
            throw new HttpException('Authentication required', 401);
          r.auth = { userId: r.headers['x-test-user'] };
          return true;
        },
      })
      .compile();
    const app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    try {
      const path = `/api/businesses/b/payroll/payments/${draft.id}`;
      await request(app.getHttpServer()).get(path).expect(401);
      check('HTTP requests require session authentication', true);
      const http = await request(app.getHttpServer())
        .get(path)
        .set('x-test-user', 'reader')
        .expect(200);
      check(
        'HTTP detail is no-store and labels mock results',
        http.headers['cache-control'] === 'no-store' &&
          (http.body as { simulation: boolean }).simulation,
      );
      await request(app.getHttpServer())
        .post(path + '/invoice')
        .set('x-test-user', 'maker')
        .send({ amountKobo: '1' })
        .expect(400);
      check('HTTP rejects spoofed payment fields', true);
      await request(app.getHttpServer())
        .get(`/api/businesses/foreign/payroll/payments/${draft.id}`)
        .set('x-test-user', 'maker')
        .expect(404);
      check('HTTP cross-business path is denied', true);
    } finally {
      await app.close();
    }

    // Sandbox notification handling uses only synthetic database rows and never calls Remita.
    const sandboxEnv = {
      ...env,
      REMITA_MODE: 'sandbox',
      REMITA_BASE_URL:
        'https://demo.remita.net/remita/exapp/api/v1/send/api/echannelsvc',
      REMITA_CREDENTIAL_ENV: 'sandbox',
      REMITA_MERCHANT_ID: '123456',
      REMITA_SERVICE_TYPE_ID: '654321',
      REMITA_API_KEY: 'test-only-fictional-key',
      PAYROLL_PLATFORM_BANK_CODE: '058',
      PAYROLL_PLATFORM_ACCOUNT_NUMBER: '0000000001',
      PAYROLL_PLATFORM_BENEFICIARY_NAME: 'Synthetic Vendor',
      REMITA_SANDBOX_FIXTURE_ACCOUNTS:
        '058:0000000001,058:0000000002,058:0000000003',
    };
    const sandbox = new PayrollPaymentService(
      db as unknown as PrismaService,
      access,
      new RemitaRuntime(new ConfigService(sandboxEnv)),
      limits,
    );
    await batch('signal');
    const signal = await sandbox.prepare(
      'maker',
      'b',
      'signal',
      payer,
      'request-signal',
    );
    await sandbox.approve('reviewer', 'b', signal.id);
    const changedRuntime = new RemitaRuntime(
      new ConfigService({
        ...sandboxEnv,
        REMITA_SERVICE_TYPE_ID: '999999',
        REMITA_SANDBOX_SPLIT_APPROVED: 'true',
      }),
    );
    const changedService = new PayrollPaymentService(
      db as unknown as PrismaService,
      access,
      changedRuntime,
      limits,
    );
    await reject(
      'changed merchant/service configuration cannot issue an approved instruction',
      () => changedService.invoice('maker', 'b', signal.id),
      409,
    );
    await db.payrollPayment.update({
      where: { id: signal.id },
      data: { state: 'CREATING' },
    });
    await db.payrollPayment.update({
      where: { id: signal.id },
      data: {
        state: 'INVOICE_READY',
        remitaRRR: '123456789012',
        providerStatus: 'UNPAID',
      },
    });
    const notification = [
      {
        rrr: '123456789012',
        orderId: signal.merchantReference,
        amount: 2100.02,
        transactiondate: '2026-10-31 00:00:00',
        type: 'PY',
      },
    ];
    check(
      'unsigned callback acknowledged as a signal only',
      (await sandbox.webhook(notification, '127.0.0.1')) === 'Ok',
    );
    const firstSignal = await db.payrollPayment.findUniqueOrThrow({
      where: { id: signal.id },
    });
    await sandbox.webhook(notification, '127.0.0.1');
    const replay = await db.payrollPayment.findUniqueOrThrow({
      where: { id: signal.id },
    });
    check(
      'webhook replay leaves collection unpaid and deduplicates the signal',
      replay.providerStatus === 'UNPAID' &&
        replay.verifiedAt === null &&
        replay.lastSignalAt?.getTime() ===
          firstSignal.lastSignalAt?.getTime() &&
        replay.reconcileRequestedAt,
    );
    await batch('lost');
    const lost = await sandbox.prepare(
      'maker',
      'b',
      'lost',
      payer,
      'request-lost',
    );
    await sandbox.approve('reviewer', 'b', lost.id);
    await db.payrollPayment.update({
      where: { id: lost.id },
      data: { state: 'CREATING' },
    });
    await db.payrollPayment.update({
      where: { id: lost.id },
      data: { state: 'INVOICE_UNKNOWN' },
    });
    await sandbox.webhook(
      [
        {
          rrr: '999999999999',
          orderId: lost.merchantReference,
          amount: 2100.02,
          type: 'PY',
        },
      ],
      '127.0.0.1',
    );
    const pending = await db.payrollPayment.findUniqueOrThrow({
      where: { id: lost.id },
    });
    check(
      'lost-RRR callbacks queue order reconciliation without trusting callback RRR',
      pending.reconcileRequestedAt &&
        pending.remitaRRR === null &&
        pending.providerStatus === 'UNKNOWN',
    );
    check(
      'business-scoped audits never store account numbers',
      !JSON.stringify(await db.auditEvent.findMany()).includes('0000000002'),
    );
    console.log(
      `${checks} Remita payroll integration checks passed. All beneficiaries synthetic; no provider network calls or real payments.`,
    );
  } finally {
    await client?.$disconnect();
    if (created) {
      assert.match(schema, /^remita_test_[a-f0-9]{16}$/);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.log('Disposable test schema removed; public data untouched.');
    }
    await admin.end();
  }
}
void main().catch((error) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
