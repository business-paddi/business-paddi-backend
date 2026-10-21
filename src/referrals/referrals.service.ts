import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthenticatedRateLimitService } from '../rate-limit/authenticated-rate-limit.service';
import {
  FIRST_PAYMENT_RATE_BPS,
  MAX_MINOR,
  PLAN_KEYS,
  BILLING_MODES,
} from './plan-catalog';
import { ReferralVault, referralHash } from './referral-vault';
import { ReferralCursor } from './referral-cursor';
import { recordReferralAudit } from './referral-audit.service';
import type { PlanSelectionDto } from './referrals.dto';

export const REFERRAL_TX = { maxWait: 15000, timeout: 30000 };
export function safeMinor(value: bigint | null): number {
  if (value === null) return 0;
  if (value < 0n || value > MAX_MINOR)
    throw new ServiceUnavailableException(
      'Referral balance cannot be displayed safely. Please contact support.',
    );
  return Number(value);
}

@Injectable()
export class ReferralsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: ReferralVault,
    private readonly cursors: ReferralCursor,
    private readonly limits: AuthenticatedRateLimitService,
  ) {}
  private async verified(
    db: Prisma.TransactionClient,
    userId: string,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { status: true, emailVerifiedAt: true },
    });
    if (!user || user.status !== 'active' || !user.emailVerifiedAt)
      throw new ForbiddenException(
        'An active, email-verified account is required.',
      );
  }
  private async rate(
    operation: string,
    userId: string,
    limit: number,
    seconds: number,
  ) {
    try {
      await this.limits.consume(operation, userId, limit, seconds);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Referral requests are temporarily unavailable. Please retry.',
      );
    }
  }
  private codeValue(
    code: {
      id: string;
      encryptedToken: string;
      tokenHash: string;
      status: string;
    } | null,
  ) {
    if (!code || code.status !== 'active') return null;
    const token = this.vault.decrypt(code.id, code.encryptedToken);
    if (referralHash(token) !== code.tokenHash)
      throw new ServiceUnavailableException(
        'Your referral code is temporarily unavailable.',
      );
    return token;
  }
  async summary(userId: string) {
    return this.prisma.$transaction(
      async (db) => {
        await this.verified(db, userId);
        const code = await db.referralCode.findUnique({
          where: { ownerUserId: userId },
        });
        const referredCount = await db.referralAttribution.count({
          where: { referrerUserId: userId },
        });
        const conversions = await db.referralAttribution.count({
          where: { referrerUserId: userId, qualifyingPaymentId: { not: null } },
        });
        const sums = await db.referralLedgerEntry.groupBy({
          by: ['currency'],
          where: { referrerUserId: userId },
          _sum: { pendingDelta: true, availableDelta: true, paidDelta: true },
          orderBy: { currency: 'asc' },
        });
        return {
          code: this.codeValue(code),
          firstPaymentRateBps: FIRST_PAYMENT_RATE_BPS,
          referredCount,
          conversions,
          earnings: sums.map((sum) => ({
            currency: sum.currency,
            pendingMinor: safeMinor(sum._sum.pendingDelta),
            availableMinor: safeMinor(sum._sum.availableDelta),
            paidMinor: safeMinor(sum._sum.paidDelta),
          })),
        };
      },
      { ...REFERRAL_TX, isolationLevel: 'RepeatableRead' },
    );
  }
  async createCode(userId: string, requestId?: string) {
    await this.rate('referral-code', userId, 20, 3600);
    return this.prisma.$transaction(async (db) => {
      await this.verified(db, userId, true);
      const existing = await db.referralCode.findUnique({
        where: { ownerUserId: userId },
      });
      if (existing) {
        const code = this.codeValue(existing);
        if (!code)
          throw new ConflictException(
            'Your referral code is disabled. Please contact support.',
          );
        return { code };
      }
      const id = randomUUID();
      const code = this.vault.generate();
      await db.referralCode.create({
        data: {
          id,
          ownerUserId: userId,
          tokenHash: referralHash(code),
          encryptedToken: this.vault.encrypt(id, code),
        },
      });
      await recordReferralAudit(db, {
        eventType: 'referral.code_created',
        actorUserId: userId,
        subjectUserId: userId,
        referrerUserId: userId,
        referralCodeId: id,
        requestId,
      });
      return { code };
    }, REFERRAL_TX);
  }
  async selectPlan(
    userId: string,
    input: PlanSelectionDto,
    requestId?: string,
  ) {
    if (!PLAN_KEYS.includes(input.plan) || !BILLING_MODES.includes(input.mode))
      throw new BadRequestException(
        'Select a known plan and billing mode (monthly or annually).',
      );
    if (input.plan === 'efficient')
      throw new BadRequestException(
        'Efficient requires a custom quote. Please use the contact form.',
      );
    if (
      input.referralCode !== undefined &&
      (typeof input.referralCode !== 'string' ||
        !/^[A-Za-z0-9_-]{6,128}$/.test(input.referralCode))
    )
      throw new BadRequestException('Referral code has invalid syntax.');
    await this.rate('referral-plan-selection', userId, 30, 60);
    const result = await this.prisma.$transaction(async (db) => {
      await this.verified(db, userId, true);
      const existingCustomer = await db.referralCustomer.findUnique({
        where: { ownerUserId: userId },
      });
      if (existingCustomer)
        await db.$queryRaw`SELECT "id" FROM "ReferralCustomer" WHERE "id" = ${existingCustomer.id} FOR UPDATE`;
      let attribution = existingCustomer
        ? await db.referralAttribution.findUnique({
            where: { customerId: existingCustomer.id },
          })
        : null;
      let code: Awaited<ReturnType<typeof db.referralCode.findUnique>> = null;
      if (input.referralCode !== undefined) {
        const hash = referralHash(input.referralCode);
        await db.$queryRaw`SELECT "id" FROM "ReferralCode" WHERE "tokenHash" = ${hash} FOR SHARE`;
        code = await db.referralCode.findUnique({ where: { tokenHash: hash } });
        const reason =
          !code || code.status !== 'active'
            ? 'invalid_or_disabled'
            : code.ownerUserId === userId
              ? 'self_referral'
              : attribution && attribution.referralCodeId !== code.id
                ? 'conflicting_attribution'
                : !attribution &&
                    (existingCustomer?.firstPaidPaymentKey ||
                      existingCustomer?.eligibility === 'ineligible')
                  ? 'prior_payment'
                  : null;
        if (reason) {
          await recordReferralAudit(db, {
            eventType: 'referral.attribution_rejected',
            actorUserId: userId,
            subjectUserId: userId,
            referredUserId: userId,
            customerId: existingCustomer?.id,
            requestId,
            metadata: { reason },
          });
          return { conflict: reason } as const;
        }
      }
      const customer =
        existingCustomer ??
        (await db.referralCustomer.create({ data: { ownerUserId: userId } }));
      if (code && !attribution) {
        attribution = await db.referralAttribution.create({
          data: {
            referralCodeId: code.id,
            referrerUserId: code.ownerUserId,
            referredUserId: userId,
            customerId: customer.id,
          },
        });
        for (const subjectUserId of [userId, code.ownerUserId])
          await recordReferralAudit(db, {
            eventType: 'referral.attribution_accepted',
            actorUserId: userId,
            subjectUserId,
            referrerUserId: code.ownerUserId,
            referredUserId: userId,
            customerId: customer.id,
            referralCodeId: code.id,
            attributionId: attribution.id,
            requestId,
          });
      }
      const existing = await db.planSelection.findUnique({ where: { userId } });
      if (
        existing &&
        existing.planKey === input.plan &&
        existing.billingMode === input.mode &&
        existing.referralAttributionId === (attribution?.id ?? null)
      )
        return {
          selectionId: existing.id,
          nextPath: '/dashboard/business',
        } as const;
      const selection = await db.planSelection.upsert({
        where: { userId },
        create: {
          userId,
          customerId: customer.id,
          planKey: input.plan,
          billingMode: input.mode,
          referralAttributionId: attribution?.id,
        },
        update: {
          planKey: input.plan,
          billingMode: input.mode,
          referralAttributionId: attribution?.id ?? null,
        },
      });
      await recordReferralAudit(db, {
        eventType: 'referral.plan_selected',
        actorUserId: userId,
        subjectUserId: userId,
        customerId: customer.id,
        attributionId: attribution?.id,
        requestId,
        metadata: { plan: input.plan, mode: input.mode },
      });
      return {
        selectionId: selection.id,
        nextPath: '/dashboard/business',
      } as const;
    }, REFERRAL_TX);
    if ('conflict' in result)
      throw new ConflictException(
        result.conflict === 'self_referral'
          ? 'You cannot use your own referral code.'
          : result.conflict === 'conflicting_attribution'
            ? 'This account already has a different referrer.'
            : result.conflict === 'prior_payment'
              ? 'This customer is not eligible for a new referral attribution.'
              : 'This referral code is invalid or disabled.',
      );
    return result;
  }
  async earnings(userId: string, cursor?: string) {
    await this.verified(this.prisma, userId);
    const scope = `earnings:${userId}`;
    const after = this.cursors.decode(scope, cursor);
    const rows = await this.prisma.referralEarning.findMany({
      where: {
        referrerUserId: userId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      include: { payment: { select: { planKey: true, billingMode: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 26,
    });
    const more = rows.length > 25;
    if (more) rows.pop();
    return {
      items: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        plan: row.payment.planKey,
        mode: row.payment.billingMode,
        currency: row.currency,
        commissionMinor: safeMinor(row.commissionMinor - row.reversedMinor),
        originalCommissionMinor: safeMinor(row.commissionMinor),
        reversedMinor: safeMinor(row.reversedMinor),
        status: row.status,
      })),
      nextCursor: more
        ? this.cursors.encode(scope, rows[rows.length - 1])
        : null,
    };
  }
}
