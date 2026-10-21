import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  commission,
  MAX_MINOR,
  providerPriceId,
  reversalTarget,
} from './plan-catalog';
import { recordReferralAudit } from './referral-audit.service';

// INTERNAL adapter contract, not a request DTO. The future adapter must verify the
// provider signature/timestamp, retrieve settled amounts and payment history from
// the provider, and map an owner-authorized workspace billing identity first.
export type VerifiedReferralEvent = {
  provider: string;
  eventId: string;
  payloadDigest: string;
  providerPaymentId: string;
} & (
  | {
      kind: 'settled';
      providerCustomerId: string;
      priceId: string;
      currency: 'USD';
      settledSubtotalMinor: bigint;
      settledAt: Date;
      firstSuccessfulPaymentId: string;
      firstSuccessfulPaymentAt: Date;
    }
  | { kind: 'refund'; cumulativeRefundMinor: bigint }
);

@Injectable()
export class ReferralSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  // Deliberately no controller, module export, checkout route or webhook receiver.
  // Enabling this flag alone cannot receive payments or bypass provider verification.
  async processVerifiedEvent(event: VerifiedReferralEvent) {
    if (this.config.get<string>('REFERRAL_SETTLEMENT_APPROVED') !== 'true')
      throw new ServiceUnavailableException(
        'Referral settlement is awaiting product approval and verified billing integration.',
      );
    if (
      !/^[a-z0-9_-]{1,40}$/.test(event.provider) ||
      !/^[a-f0-9]{64}$/.test(event.payloadDigest) ||
      !event.eventId ||
      event.eventId.length > 200 ||
      !event.providerPaymentId ||
      event.providerPaymentId.length > 200
    )
      throw new BadRequestException('Invalid verified payment metadata.');
    return this.prisma.$transaction(
      async (db) => {
        // Serialize provider replays, including refund-before-payment delivery.
        await db.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${JSON.stringify([event.provider, event.providerPaymentId])}, 0))`;
        const existing = await db.referralWebhookEvent.findUnique({
          where: {
            provider_eventId: {
              provider: event.provider,
              eventId: event.eventId,
            },
          },
        });
        if (existing && existing.payloadDigest !== event.payloadDigest)
          throw new ConflictException(
            'Webhook event identifier was reused with different content.',
          );
        if (existing?.status === 'processed') return { duplicate: true };
        const envelope =
          existing ??
          (await db.referralWebhookEvent.create({
            data: {
              provider: event.provider,
              eventId: event.eventId,
              payloadDigest: event.payloadDigest,
              providerPaymentId: event.providerPaymentId,
              cumulativeRefundMinor:
                event.kind === 'refund' ? event.cumulativeRefundMinor : null,
            },
          }));
        if (event.kind === 'refund')
          return this.refund(
            db,
            envelope.id,
            event.provider,
            event.providerPaymentId,
            event.cumulativeRefundMinor,
          );
        const amount = event.settledSubtotalMinor;
        if (
          typeof amount !== 'bigint' ||
          amount < 0n ||
          amount > MAX_MINOR ||
          event.currency !== 'USD' ||
          !Number.isFinite(event.settledAt.getTime()) ||
          !Number.isFinite(event.firstSuccessfulPaymentAt.getTime()) ||
          event.firstSuccessfulPaymentAt > event.settledAt
        )
          throw new BadRequestException(
            'Invalid settled subscription amount or date.',
          );
        const identity = await db.referralBillingIdentity.findUnique({
          where: {
            provider_providerCustomerId: {
              provider: event.provider,
              providerCustomerId: event.providerCustomerId,
            },
          },
        });
        if (!identity)
          throw new ConflictException(
            'No authorized billing customer mapping exists.',
          );
        await db.$queryRaw`SELECT "id" FROM "ReferralCustomer" WHERE "id" = ${identity.customerId} FOR UPDATE`;
        const customer = await db.referralCustomer.findUniqueOrThrow({
          where: { id: identity.customerId },
        });
        const prices = (['growth', 'standard'] as const)
          .flatMap((plan) =>
            (['monthly', 'annually'] as const).map((mode) => ({
              plan,
              mode,
              id: providerPriceId(this.config, plan, mode),
            })),
          )
          .filter((item) => item.id && item.id === event.priceId);
        if (prices.length !== 1)
          throw new BadRequestException(
            'Payment does not match one unambiguous configured subscription price.',
          );
        const price = prices[0];
        const firstKey = JSON.stringify([
          event.provider,
          event.firstSuccessfulPaymentId,
        ]);
        const priorPayment = await db.referralPayment.findUnique({
          where: {
            provider_providerPaymentId: {
              provider: event.provider,
              providerPaymentId: event.providerPaymentId,
            },
          },
        });
        if (amount > 0n && !customer.firstPaidPaymentKey)
          await db.referralCustomer.update({
            where: { id: customer.id },
            data: { firstPaidPaymentKey: firstKey },
          });
        const payment = await db.referralPayment.upsert({
          where: {
            provider_providerPaymentId: {
              provider: event.provider,
              providerPaymentId: event.providerPaymentId,
            },
          },
          create: {
            provider: event.provider,
            providerPaymentId: event.providerPaymentId,
            customerId: customer.id,
            planKey: price.plan,
            billingMode: price.mode,
            currency: event.currency,
            settledSubtotalMinor: amount,
            settledAt: event.settledAt,
          },
          update: {},
        });
        if (
          payment.customerId !== customer.id ||
          payment.settledSubtotalMinor !== amount ||
          payment.currency !== event.currency ||
          payment.settledAt.getTime() !== event.settledAt.getTime() ||
          payment.planKey !== price.plan ||
          payment.billingMode !== price.mode
        )
          throw new ConflictException('Settled payment metadata changed.');
        const attribution = await db.referralAttribution.findUnique({
          where: { customerId: customer.id },
        });
        const first =
          amount > 0n &&
          event.providerPaymentId === event.firstSuccessfulPaymentId &&
          (!customer.firstPaidPaymentKey ||
            customer.firstPaidPaymentKey === firstKey);
        const qualifies =
          first &&
          customer.eligibility === 'eligible' &&
          attribution &&
          attribution.attributedAt <= event.firstSuccessfulPaymentAt &&
          customer.createdAt <= event.firstSuccessfulPaymentAt &&
          (!priorPayment || attribution.qualifyingPaymentId === payment.id) &&
          (!attribution.qualifyingPaymentId ||
            attribution.qualifyingPaymentId === payment.id);
        if (qualifies && !attribution.qualifyingPaymentId) {
          await db.referralAttribution.update({
            where: { id: attribution.id },
            data: { qualifyingPaymentId: payment.id },
          });
          const reward = commission(amount);
          await recordReferralAudit(db, {
            eventType: 'referral.payment_qualified',
            subjectUserId: attribution.referrerUserId,
            referrerUserId: attribution.referrerUserId,
            referredUserId: attribution.referredUserId,
            customerId: customer.id,
            attributionId: attribution.id,
            paymentId: payment.id,
            correlationId: envelope.id,
            metadata: {
              currency: event.currency,
              amountMinor: amount.toString(),
            },
          });
          if (reward > 0n) {
            const earning = await db.referralEarning.create({
              data: {
                attributionId: attribution.id,
                referrerUserId: attribution.referrerUserId,
                customerId: customer.id,
                paymentId: payment.id,
                currency: event.currency,
                eligibleAmountMinor: amount,
                commissionMinor: reward,
              },
            });
            await db.referralLedgerEntry.create({
              data: {
                earningId: earning.id,
                referrerUserId: earning.referrerUserId,
                currency: earning.currency,
                kind: 'credit',
                idempotencyKey: `credit:${payment.id}`,
                pendingDelta: reward,
              },
            });
            await recordReferralAudit(db, {
              eventType: 'referral.reward_credited',
              subjectUserId: earning.referrerUserId,
              referrerUserId: earning.referrerUserId,
              customerId: customer.id,
              attributionId: attribution.id,
              earningId: earning.id,
              paymentId: payment.id,
              correlationId: envelope.id,
              metadata: {
                currency: earning.currency,
                commissionMinor: reward.toString(),
                status: 'pending',
              },
            });
          }
        } else if (!attribution?.qualifyingPaymentId) {
          await recordReferralAudit(db, {
            eventType: 'referral.payment_not_qualified',
            subjectUserId: customer.ownerUserId,
            referredUserId: customer.ownerUserId,
            customerId: customer.id,
            paymentId: payment.id,
            correlationId: envelope.id,
            metadata: {
              reason: !first
                ? 'not_first_paid_payment'
                : customer.eligibility !== 'eligible'
                  ? 'customer_history_unapproved'
                  : 'no_prior_attribution',
            },
          });
        }
        await db.referralWebhookEvent.update({
          where: { id: envelope.id },
          data: {
            status: 'processed',
            processedAt: new Date(),
            errorCode: null,
          },
        });
        const refunds = await db.referralWebhookEvent.findMany({
          where: {
            provider: event.provider,
            providerPaymentId: event.providerPaymentId,
            status: 'pending',
            cumulativeRefundMinor: { not: null },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        for (const refund of refunds)
          await this.refund(
            db,
            refund.id,
            event.provider,
            event.providerPaymentId,
            refund.cumulativeRefundMinor!,
          );
        return { duplicate: false, qualified: Boolean(qualifies) };
      },
      { maxWait: 15000, timeout: 60000 },
    );
  }
  private async refund(
    db: Prisma.TransactionClient,
    eventId: string,
    provider: string,
    providerPaymentId: string,
    cumulative: bigint,
  ) {
    if (
      typeof cumulative !== 'bigint' ||
      cumulative < 0n ||
      cumulative > MAX_MINOR
    )
      throw new BadRequestException('Invalid cumulative refund amount.');
    const payment = await db.referralPayment.findUnique({
      where: { provider_providerPaymentId: { provider, providerPaymentId } },
    });
    if (!payment) return { deferred: true };
    if (cumulative > payment.settledSubtotalMinor)
      throw new BadRequestException(
        'Refund exceeds the settled subscription subtotal.',
      );
    const earning = await db.referralEarning.findUnique({
      where: { paymentId: payment.id },
    });
    if (
      earning?.status === 'paid' &&
      cumulative > payment.refundedSubtotalMinor
    ) {
      await db.referralWebhookEvent.update({
        where: { id: eventId },
        data: {
          status: 'quarantined',
          errorCode: 'paid_refund_requires_settlement_policy',
        },
      });
      await recordReferralAudit(db, {
        eventType: 'referral.refund_quarantined',
        subjectUserId: earning.referrerUserId,
        referrerUserId: earning.referrerUserId,
        customerId: payment.customerId,
        earningId: earning.id,
        paymentId: payment.id,
        correlationId: eventId,
        metadata: { reason: 'paid_refund_requires_settlement_policy' },
      });
      return { quarantined: true };
    }
    if (cumulative > payment.refundedSubtotalMinor) {
      await db.referralPayment.update({
        where: { id: payment.id },
        data: { refundedSubtotalMinor: cumulative },
      });
      if (earning) {
        const target = reversalTarget(
          earning.commissionMinor,
          cumulative,
          earning.eligibleAmountMinor,
        );
        const delta = target - earning.reversedMinor;
        if (delta > 0n) {
          await db.referralEarning.update({
            where: { id: earning.id },
            data: {
              reversedMinor: target,
              ...(target === earning.commissionMinor
                ? { status: 'reversed' }
                : {}),
            },
          });
          await db.referralLedgerEntry.create({
            data: {
              earningId: earning.id,
              referrerUserId: earning.referrerUserId,
              currency: earning.currency,
              idempotencyKey: `reversal:${eventId}`,
              kind: 'reversal',
              ...(earning.status === 'available'
                ? { availableDelta: -delta }
                : { pendingDelta: -delta }),
            },
          });
          await recordReferralAudit(db, {
            eventType: 'referral.reward_reversed',
            subjectUserId: earning.referrerUserId,
            referrerUserId: earning.referrerUserId,
            earningId: earning.id,
            customerId: payment.customerId,
            paymentId: payment.id,
            correlationId: eventId,
            metadata: {
              currency: earning.currency,
              reversedMinor: delta.toString(),
            },
          });
        }
      }
    }
    await db.referralWebhookEvent.update({
      where: { id: eventId },
      data: { status: 'processed', processedAt: new Date(), errorCode: null },
    });
    return { processed: true };
  }
}
