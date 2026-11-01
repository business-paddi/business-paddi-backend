import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PayrollPayment, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedRateLimitService } from '../../rate-limit/authenticated-rate-limit.service';
import type { Permission } from '../../business-foundation/permission-catalog';
import {
  encryptPayrollField,
  decryptPayrollField,
} from '../../business-foundation/sensitive-fields';
import { PayrollAccessService } from '../payroll-access.service';
import { storedJson } from '../payroll-events.service';
import { fail } from '../payroll-calculation';
import type { Calculation, Source } from '../payroll-calculation';
import type {
  Beneficiary,
  InvoiceInput,
  PaymentSnapshot,
} from './payment-provider';
import { digestPayment, nairaToKobo, validateSnapshot } from './payment-rules';
import { RemitaRuntime } from './remita-runtime';
import type {
  PreparePayrollPaymentDto,
  MockPaymentEventDto,
} from './payment.dto';

@Injectable()
export class PayrollPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly runtime: RemitaRuntime,
    private readonly limits: AuthenticatedRateLimitService,
  ) {}

  private async audit(
    db: Prisma.TransactionClient,
    p: PayrollPayment,
    actor: string | null,
    event: string,
  ) {
    await db.auditEvent.create({
      data: {
        eventId: randomUUID(),
        businessId: p.businessId,
        userId: actor,
        eventType: `business.payroll.payment.${event}`,
        category: 'business',
        outcome: 'success',
        metadata: {
          paymentId: p.id,
          batchId: p.batchId,
          simulation: p.provider === 'remita_mock',
        },
      },
    });
  }
  private async transaction<T>(
    user: string,
    business: string,
    permission: Permission,
    work: (db: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.prisma.$transaction(
      async (db) => {
        await this.access.context(
          user,
          business,
          [permission, 'payroll:view_details'],
          db,
          true,
        );
        await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll-payment:${business}`},0))::text`;
        return work(db);
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
  private async find(
    db: Prisma.TransactionClient,
    business: string,
    id: string,
  ) {
    const p = await db.payrollPayment.findUnique({
      where: { businessId_id: { businessId: business, id } },
    });
    if (!p) fail('PAYROLL_PAYMENT_NOT_FOUND', 404);
    return p;
  }
  private clear(p: PayrollPayment): PaymentSnapshot {
    const snapshot = p.snapshot as unknown as PaymentSnapshot;
    if (digestPayment(snapshot) !== p.snapshotHash)
      fail('PAYROLL_SNAPSHOT_INTEGRITY_ERROR', 409);
    return {
      ...snapshot,
      beneficiaries: snapshot.beneficiaries.map((b) => ({
        ...b,
        account: decryptPayrollField(
          b.account,
          this.runtime.environment().PAYROLL_ENCRYPTION_KEY!,
        ),
      })),
    };
  }
  view(p: PayrollPayment) {
    const s = p.snapshot as unknown as PaymentSnapshot;
    return {
      id: p.id,
      businessId: p.businessId,
      batchId: p.batchId,
      provider: p.provider,
      simulation: p.provider === 'remita_mock',
      state: p.state,
      merchantReference: p.merchantReference,
      remitaRRR: p.remitaRRR,
      providerStatus: p.providerStatus,
      settlementStatus: p.settlementStatus,
      period: s.period,
      currency: s.currency,
      totalNetSalaryKobo: p.totalNetSalaryKobo.toString(),
      platformFeeKobo: p.platformFeeKobo.toString(),
      providerFeeKobo: p.providerFeeKobo?.toString() ?? null,
      totalInvoiceKobo: p.totalInvoiceKobo.toString(),
      payer: { name: s.payerName, email: s.payerEmail, phone: s.payerPhone },
      beneficiaries: s.beneficiaries.map((b) => ({
        ...b,
        account: '[encrypted; withheld]',
        status:
          (
            p.recipientEvidence as { lineItemId: string; status: string }[]
          ).find((e) => e.lineItemId === b.lineItemId)?.status ?? 'UNKNOWN',
      })),
      createdBy: p.createdByUserId,
      approvedBy: p.approvedByUserId,
      approvedAt: p.approvedAt,
      verifiedAt: p.verifiedAt,
      lastCheckedAt: p.lastCheckedAt,
      lastErrorCode: p.lastErrorCode,
      paymentUrl: null,
      notice:
        p.provider === 'remita_mock'
          ? 'SIMULATION ONLY. No real invoice, transfer or settlement.'
          : 'RRR payment confirmation does not establish beneficiary settlement; pay only through Remita-approved instructions.',
    };
  }
  async prepare(
    user: string,
    business: string,
    batchId: string,
    input: PreparePayrollPaymentDto,
    key?: string,
  ) {
    const mode = this.runtime.mode();
    if (!key || !/^[A-Za-z0-9_-]{1,100}$/.test(key))
      fail('IDEMPOTENCY_KEY_REQUIRED');
    await this.limits.consume('payroll-payment-prepare', user, 20, 60);
    return this.transaction(user, business, 'payments:create', async (db) => {
      const requestHash = digestPayment({ batchId, input });
      const previous = await db.payrollPayment.findUnique({
        where: {
          businessId_createdByUserId_requestKey: {
            businessId: business,
            createdByUserId: user,
            requestKey: key,
          },
        },
      });
      if (previous) {
        if (previous.requestHash !== requestHash)
          fail('IDEMPOTENCY_CONFLICT', 409);
        return this.view(previous);
      }
      const batch = await db.payrollBatch.findUnique({
        where: { businessId_id: { businessId: business, id: batchId } },
      });
      if (!batch) fail('PAYROLL_NOT_FOUND', 404);
      if (
        batch.status !== 'approved' ||
        !batch.approvedAt ||
        batch.currency !== 'NGN'
      )
        fail('APPROVED_NGN_PAYROLL_REQUIRED', 409);
      if (
        await db.payrollPayment.findFirst({
          where: { businessId: business, batchId, state: { not: 'CANCELLED' } },
        })
      )
        fail('PAYROLL_INSTRUCTION_EXISTS', 409);
      const recipients = await db.payrollRecipient.findMany({
        where: { businessId: business, batchId, removed: false },
        orderBy: { id: 'asc' },
      });
      const env = this.runtime.environment(),
        encryptionKey = env.PAYROLL_ENCRYPTION_KEY!;
      const beneficiaries: Beneficiary[] = recipients.map((r) => {
        const source = r.source as unknown as Source,
          calculation = r.calculation as unknown as Calculation;
        if (
          calculation.readiness !== 'ready' ||
          !calculation.totals ||
          source.bank.verificationStatus !== 'verified' ||
          !source.bank.accountNumber ||
          !source.bank.accountName ||
          !source.bank.bankCode
        )
          fail('PAYROLL_RECIPIENT_NOT_READY', 422);
        return {
          lineItemId: r.id,
          employeeId: r.employeeId,
          recipientType: 'EMPLOYEE',
          name: decryptPayrollField(source.bank.accountName, encryptionKey),
          bankCode: source.bank.bankCode,
          account: decryptPayrollField(
            source.bank.accountNumber,
            encryptionKey,
          ),
          amountKobo: nairaToKobo(calculation.totals.netAmount).toString(),
        };
      });
      const salary = beneficiaries.reduce(
          (sum, b) => sum + BigInt(b.amountKobo),
          0n,
        ),
        fee = BigInt(env.PAYROLL_PLATFORM_FEE_KOBO ?? '10000');
      const batchCalculation = batch.calculation as unknown as {
        calculationStatus: string;
        totals?: { netAmount: string };
      };
      if (
        batchCalculation.calculationStatus !== 'ready' ||
        !batchCalculation.totals ||
        nairaToKobo(batchCalculation.totals.netAmount) !== salary
      )
        fail('APPROVED_PAYROLL_TOTAL_MISMATCH', 409);
      beneficiaries.push({
        lineItemId: 'fee-' + randomUUID(),
        employeeId: null,
        recipientType: 'PLATFORM_FEE',
        name:
          mode === 'mock'
            ? 'BusinessPaddi MOCK service fee'
            : env.PAYROLL_PLATFORM_BENEFICIARY_NAME!,
        bankCode: mode === 'mock' ? '058' : env.PAYROLL_PLATFORM_BANK_CODE!,
        account:
          mode === 'mock' ? '0000000001' : env.PAYROLL_PLATFORM_ACCOUNT_NUMBER!,
        amountKobo: fee.toString(),
      });
      const snapshot: PaymentSnapshot = {
        version: 1,
        batchRevision: batch.revision,
        period: `${batch.periodStart}/${batch.periodEnd}`,
        currency: 'NGN',
        payerName: input.payerName,
        payerEmail: input.payerEmail,
        payerPhone: input.payerPhone,
        providerBinding: this.providerBinding(),
        totalNetSalaryKobo: salary.toString(),
        platformFeeKobo: fee.toString(),
        providerFeeKobo: null,
        totalInvoiceKobo: (salary + fee).toString(),
        beneficiaries,
      };
      validateSnapshot(snapshot);
      if (
        mode === 'mock' &&
        beneficiaries.some((b) => !/^0000000\d{3}$/.test(b.account))
      )
        fail('MOCK_REQUIRES_SYNTHETIC_BENEFICIARIES', 422);
      if (mode === 'sandbox') {
        const fixtures = new Set(
          env.REMITA_SANDBOX_FIXTURE_ACCOUNTS?.split(','),
        );
        if (
          beneficiaries.some((b) => !fixtures.has(`${b.bankCode}:${b.account}`))
        )
          fail('UNAPPROVED_SANDBOX_BENEFICIARY', 422);
      }
      const encrypted = {
        ...snapshot,
        beneficiaries: beneficiaries.map((b) => ({
          ...b,
          accountLast4: b.account.slice(-4),
          account: encryptPayrollField(b.account, encryptionKey),
        })),
      };
      const p = await db.payrollPayment.create({
        data: {
          id: randomUUID(),
          businessId: business,
          batchId,
          provider: 'remita_' + mode,
          merchantReference: 'bp_' + randomUUID(),
          snapshot: storedJson(encrypted),
          snapshotHash: digestPayment(encrypted),
          createdByUserId: user,
          requestKey: key,
          requestHash,
          totalNetSalaryKobo: salary,
          platformFeeKobo: fee,
          totalInvoiceKobo: salary + fee,
        },
      });
      await this.audit(db, p, user, 'prepared');
      return this.view(p);
    });
  }
  async get(user: string, business: string, id: string) {
    await this.access.context(user, business, [
      'invoices:view',
      'payroll:view_details',
    ]);
    await this.limits.consume('payroll-payment-read', user, 60, 60);
    return this.view(await this.find(this.prisma, business, id));
  }
  async approve(user: string, business: string, id: string) {
    this.runtime.mode();
    await this.limits.consume('payroll-payment-approve', user, 20, 60);
    return this.transaction(user, business, 'payments:approve', async (db) => {
      let p = await this.find(db, business, id);
      const batch = await db.payrollBatch.findUniqueOrThrow({
        where: { businessId_id: { businessId: business, id: p.batchId } },
      });
      if (p.createdByUserId === user || batch.contributorUserIds.includes(user))
        fail('INDEPENDENT_REVIEWER_REQUIRED', 403);
      if (p.state !== 'DRAFT') fail('INVALID_PAYMENT_TRANSITION', 409);
      validateSnapshot(this.clear(p));
      p = await db.payrollPayment.update({
        where: { id },
        data: {
          state: 'APPROVED',
          approvedByUserId: user,
          approvedAt: new Date(),
        },
      });
      await this.audit(db, p, user, 'approved');
      return this.view(p);
    });
  }
  private providerBinding() {
    const env = this.runtime.environment();
    return digestPayment({
      mode: this.runtime.mode(),
      merchantId: env.REMITA_MERCHANT_ID ?? null,
      serviceTypeId: env.REMITA_SERVICE_TYPE_ID ?? null,
      baseUrl: env.REMITA_BASE_URL ?? null,
    });
  }
  private input(p: PayrollPayment): InvoiceInput {
    if (p.provider !== 'remita_' + this.runtime.mode())
      fail('PAYROLL_PROVIDER_MODE_MISMATCH', 409);
    const snapshot = this.clear(p);
    if (snapshot.providerBinding !== this.providerBinding())
      fail('REMITA_MERCHANT_BINDING_CHANGED', 409);
    validateSnapshot(snapshot);
    return {
      reference: p.merchantReference,
      rrr: p.remitaRRR,
      snapshot,
      scenario: p.mockScenario,
    };
  }
  async invoice(user: string, business: string, id: string) {
    this.runtime.assertInvoiceEnabled();
    await this.limits.consume('payroll-payment-invoice', user, 10, 60);
    const claim = await this.transaction(
      user,
      business,
      'invoices:create',
      async (db) => {
        const p = await this.find(db, business, id);
        if (['CREATING', 'INVOICE_UNKNOWN', 'INVOICE_READY'].includes(p.state))
          return { p, claimed: false };
        if (p.state !== 'APPROVED') fail('PAYMENT_APPROVAL_REQUIRED', 409);
        this.input(p);
        const updated = await db.payrollPayment.update({
          where: { id },
          data: { state: 'CREATING', reconcileRequestedAt: new Date() },
        });
        await this.audit(db, updated, user, 'invoice_claimed');
        return { p: updated, claimed: true };
      },
    );
    if (!claim.claimed) return this.view(claim.p);
    try {
      const result = await this.runtime
        .provider()
        .createInvoice(this.input(claim.p));
      return await this.prisma.$transaction(async (db) => {
        await db.payrollPayment.updateMany({
          where: { id, state: 'CREATING' },
          data: {
            remitaRRR: result.rrr,
            state: 'INVOICE_READY',
            providerStatus: 'UNPAID',
            reconcileRequestedAt: new Date(),
            lastErrorCode: null,
          },
        });
        const p = await this.find(db, business, id);
        await this.audit(db, p, user, 'invoice_created');
        return this.view(p);
      });
    } catch {
      // A timeout may have created an RRR. Never issue paymentinit again for this instruction.
      await this.prisma.payrollPayment.updateMany({
        where: { id, state: 'CREATING' },
        data: {
          state: 'INVOICE_UNKNOWN',
          lastErrorCode: 'INVOICE_OUTCOME_UNKNOWN',
          reconcileRequestedAt: new Date(),
        },
      });
      return this.view(await this.find(this.prisma, business, id));
    }
  }
  async refresh(user: string, business: string, id: string) {
    await this.access.context(user, business, [
      'invoices:view',
      'payroll:view_details',
    ]);
    await this.limits.consume('payroll-payment-refresh', user, 10, 60);
    return this.reconcile(business, id, user);
  }
  async reconcile(business: string, id: string, actor: string | null = null) {
    let p = await this.find(this.prisma, business, id);
    if (
      ![
        'CREATING',
        'INVOICE_UNKNOWN',
        'INVOICE_READY',
        'CANCEL_UNKNOWN',
      ].includes(p.state)
    )
      return this.view(p);
    const token = randomUUID();
    await this.prisma.payrollPayment.update({
      where: { id },
      data: { checkToken: token, reconcileRequestedAt: null },
    });
    try {
      const input = this.input(p),
        result = await this.runtime.provider().verifyPayment(input);
      const identity =
        result.reference === p.merchantReference &&
        !!result.rrr &&
        (!p.remitaRRR || p.remitaRRR === result.rrr);
      const amount = result.amountKobo === p.totalInvoiceKobo.toString();
      const trusted =
        identity &&
        amount &&
        (p.provider === 'remita_mock' ? result.simulation : !result.simulation);
      const collection = trusted
        ? result.collection
        : result.collection === 'PAID' || result.collection === 'REVERSED'
          ? 'MISMATCH'
          : 'UNKNOWN';
      const evidence =
        trusted &&
        result.simulation &&
        ['PAID', 'REVERSED'].includes(collection)
          ? result.recipientEvidence.filter((e) =>
              input.snapshot.beneficiaries.some(
                (b) => b.lineItemId === e.lineItemId,
              ),
            )
          : [];
      return await this.prisma.$transaction(async (db) => {
        const changed = await db.payrollPayment.updateMany({
          where: {
            id,
            checkToken: token,
            state: {
              in: [
                'CREATING',
                'INVOICE_UNKNOWN',
                'INVOICE_READY',
                'CANCEL_UNKNOWN',
              ],
            },
          },
          data: {
            ...(identity && p.state !== 'CANCEL_UNKNOWN'
              ? { remitaRRR: result.rrr, state: 'INVOICE_READY' }
              : {}),
            providerStatus: collection,
            settlementStatus:
              trusted && result.simulation ? result.settlement : 'UNKNOWN',
            providerCode: result.code,
            recipientEvidence: storedJson(evidence),
            verifiedAt: trusted && collection === 'PAID' ? new Date() : null,
            lastCheckedAt: new Date(),
            lastErrorCode: trusted ? null : 'PROVIDER_EVIDENCE_UNVERIFIED',
            checkToken: null,
          },
        });
        p = await this.find(db, business, id);
        if (changed.count) await this.audit(db, p, actor, 'status_checked');
        return this.view(p);
      });
    } catch {
      await this.prisma.payrollPayment.updateMany({
        where: { id, checkToken: token },
        data: {
          checkToken: null,
          lastCheckedAt: new Date(),
          lastErrorCode: 'PROVIDER_STATUS_UNAVAILABLE',
          reconcileRequestedAt: new Date(Date.now() + 60000),
        },
      });
      return this.view(await this.find(this.prisma, business, id));
    }
  }
  async cancel(user: string, business: string, id: string) {
    this.runtime.mode();
    await this.limits.consume('payroll-payment-cancel', user, 10, 60);
    const claim = await this.transaction(
      user,
      business,
      'payments:cancel',
      async (db) => {
        const p = await this.find(db, business, id);
        if (p.state === 'CANCELLED') return { p, external: false };
        if (['DRAFT', 'APPROVED'].includes(p.state)) {
          const updated = await db.payrollPayment.update({
            where: { id },
            data: { state: 'CANCELLED' },
          });
          await this.audit(db, updated, user, 'cancelled');
          return { p: updated, external: false };
        }
        if (p.state !== 'INVOICE_READY' || p.providerStatus !== 'UNPAID')
          fail('INVOICE_NOT_VERIFIED_UNPAID', 409);
        const updated = await db.payrollPayment.update({
          where: { id },
          data: { state: 'CANCEL_REQUESTED', checkToken: null },
        });
        return { p: updated, external: true };
      },
    );
    if (!claim.external) return this.view(claim.p);
    try {
      await this.runtime.provider().cancelUnpaidInvoice(this.input(claim.p));
      return await this.prisma.$transaction(async (db) => {
        const p = await db.payrollPayment.update({
          where: { id },
          data: {
            state: 'CANCELLED',
            checkToken: null,
            recipientEvidence: [],
            settlementStatus: 'UNKNOWN',
          },
        });
        await this.audit(db, p, user, 'cancelled');
        return this.view(p);
      });
    } catch {
      await this.prisma.payrollPayment.update({
        where: { id },
        data: {
          state: 'CANCEL_UNKNOWN',
          lastErrorCode: 'CANCELLATION_OUTCOME_UNKNOWN',
          reconcileRequestedAt: new Date(),
        },
      });
      return this.view(await this.find(this.prisma, business, id));
    }
  }
  async mockEvent(
    user: string,
    business: string,
    id: string,
    body: MockPaymentEventDto,
  ) {
    if (this.runtime.mode() !== 'mock') fail('MOCK_ONLY', 404);
    await this.limits.consume('payroll-payment-mock', user, 30, 60);
    return this.transaction(user, business, 'invoices:create', async (db) => {
      const p = await this.find(db, business, id);
      this.input(p);
      if (['CANCELLED', 'CANCEL_REQUESTED', 'CANCEL_UNKNOWN'].includes(p.state))
        fail('INVALID_PAYMENT_TRANSITION', 409);
      const previous = await db.payrollMockEvent.findUnique({
        where: { paymentId_eventId: { paymentId: id, eventId: body.eventId } },
      });
      if (previous) {
        if (previous.scenario !== body.scenario)
          fail('MOCK_EVENT_CONFLICT', 409);
        return this.view(p);
      }
      await db.payrollMockEvent.create({
        data: {
          businessId: business,
          paymentId: id,
          eventId: body.eventId,
          scenario: body.scenario,
        },
      });
      const updated = await db.payrollPayment.update({
        where: { id },
        data: {
          mockScenario: body.scenario,
          reconcileRequestedAt: ['DRAFT', 'APPROVED'].includes(p.state)
            ? null
            : new Date(),
        },
      });
      await this.audit(db, p, user, 'mock_event');
      return this.view(updated);
    });
  }
  async webhook(body: unknown, ip: string) {
    if (
      this.runtime.environment().PAYROLL_PROVIDER !== 'remita' ||
      this.runtime.environment().REMITA_MODE !== 'sandbox'
    )
      fail('SANDBOX_WEBHOOK_ONLY', 404);
    await this.limits.consume('remita-signal', ip, 30, 60);
    if (!Array.isArray(body) || !body.length || body.length > 20)
      fail('INVALID_REMITA_NOTIFICATION');
    for (const raw of body as unknown[]) {
      if (!raw || typeof raw !== 'object') fail('INVALID_REMITA_NOTIFICATION');
      const signal = raw as Record<string, unknown>;
      const reference = signal.orderId ?? signal.orderRef;
      if (
        typeof signal.rrr !== 'string' ||
        !/^\d{6,30}$/.test(signal.rrr) ||
        typeof reference !== 'string' ||
        reference.length > 80
      )
        fail('INVALID_REMITA_NOTIFICATION');
      const p = await this.prisma.payrollPayment.findFirst({
        where: {
          provider: 'remita_sandbox',
          merchantReference: reference,
          OR: [
            { remitaRRR: signal.rrr },
            { remitaRRR: null, state: { in: ['CREATING', 'INVOICE_UNKNOWN'] } },
          ],
          state: { not: 'CANCELLED' },
        },
      });
      if (!p) continue; // Generic acknowledgement does not reveal known references.
      const fingerprint = digestPayment([
        signal.rrr,
        reference,
        signal.transactiondate,
        signal.amount,
        signal.type,
      ]);
      await this.prisma.$transaction(async (db) => {
        const accepted = await db.payrollPayment.updateMany({
          where: {
            id: p.id,
            state: { not: 'CANCELLED' },
            OR: [
              { lastSignalHash: { not: fingerprint } },
              { lastSignalHash: null },
              { lastSignalAt: { lt: new Date(Date.now() - 60000) } },
            ],
          },
          data: {
            lastSignalHash: fingerprint,
            lastSignalAt: new Date(),
            reconcileRequestedAt: new Date(),
          },
        });
        if (accepted.count) await this.audit(db, p, null, 'signal_received');
      });
    }
    return 'Ok';
  }
}
