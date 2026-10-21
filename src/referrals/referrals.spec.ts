import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  catalog,
  commission,
  planAmount,
  reversalTarget,
  MAX_MINOR,
} from './plan-catalog';
import { ReferralVault, referralHash } from './referral-vault';
import { ReferralCursor } from './referral-cursor';
import { EmptyReferralDto, PlanSelectionDto } from './referrals.dto';
import { ReferralsService, safeMinor } from './referrals.service';
import { ReferralSettlementService } from './referral-settlement.service';
import { ReferralAuditService } from './referral-audit.service';
import type { PrismaService } from '../database/prisma.service';
import type { AuthenticatedRateLimitService } from '../rate-limit/authenticated-rate-limit.service';

const config = new ConfigService({
  VERIFICATION_CODE_PEPPER: 'test-only-secret-referral-root-pepper',
});
describe('authoritative plan catalog and integer settlement', () => {
  it('publishes exact agreed prices, the 14-day trial and custom quotes without enabling checkout', () => {
    expect(planAmount('growth', 'monthly')).toBe(1877);
    expect(planAmount('growth', 'annually')).toBe(19145);
    expect(planAmount('standard', 'monthly')).toBe(4130);
    expect(planAmount('standard', 'annually')).toBe(42126);
    expect(planAmount('starter', 'annually')).toBe(0);
    expect(planAmount('efficient', 'annually')).toBeNull();
    expect(catalog().plans[0].trialDays).toBe(14);
    expect(catalog().plans.every((p) => !p.checkoutAvailable)).toBe(true);
  });
  it('rounds first-payment commission once and bounds cumulative partial reversals', () => {
    expect(commission(19145n)).toBe(1915n);
    expect(commission(42126n)).toBe(4213n);
    expect(commission(5n)).toBe(1n);
    let previous = 0n;
    let reversed = 0n;
    for (let amount = 1n; amount <= 101n; amount++) {
      const target = reversalTarget(commission(101n), amount, 101n);
      expect(target >= previous).toBe(true);
      reversed += target - previous;
      previous = target;
    }
    expect(reversed).toBe(commission(101n));
    expect(() => reversalTarget(10n, 102n, 101n)).toThrow(BadRequestException);
    expect(() => commission(-1n)).toThrow();
    expect(safeMinor(MAX_MINOR)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => safeMinor(MAX_MINOR + 1n)).toThrow(
      ServiceUnavailableException,
    );
  });
});
describe('referral tokens, cursors and request boundaries', () => {
  it('uses stable recoverable encrypted token material, not predictable IDs or plaintext storage', () => {
    const vault = new ReferralVault(config);
    const code = vault.generate();
    const ciphertext = vault.encrypt('id', code);
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(vault.generate()).not.toBe(code);
    expect(referralHash(code)).toMatch(/^[a-f0-9]{64}$/);
    expect(ciphertext).not.toContain(code);
    expect(vault.decrypt('id', ciphertext)).toBe(code);
    expect(() => vault.decrypt('other', ciphertext)).toThrow();
    expect(() => vault.decrypt('id', ciphertext + 'corrupt')).toThrow();
  });
  it('binds pagination to account, operation and filters and rejects tampering', () => {
    const cursors = new ReferralCursor(config);
    const row = { id: 'earning', createdAt: new Date('2030-01-01T00:00:00Z') };
    const token = cursors.encode('earnings:user1', row);
    expect(cursors.decode('earnings:user1', token)).toEqual(row);
    expect(() => cursors.decode('earnings:user2', token)).toThrow(
      BadRequestException,
    );
    expect(() => cursors.decode('audit:user1', token)).toThrow(
      BadRequestException,
    );
    expect(() => cursors.decode('earnings:user1', token + 'x')).toThrow(
      BadRequestException,
    );
  });
  it('accepts only canonical plans, modes and token syntax; never accepts actor IDs or prices', async () => {
    for (const body of [
      { plan: 'growth', mode: 'annually', referralCode: 'abc_def-123' },
      { plan: 'starter', mode: 'monthly' },
    ])
      expect(
        await validate(plainToInstance(PlanSelectionDto, body), {
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      ).toHaveLength(0);
    for (const body of [
      { plan: 'growth', mode: 'annual' },
      { plan: 'unknown', mode: 'monthly' },
      { plan: 'growth', mode: 'monthly', userId: 'victim' },
      { plan: 'growth', mode: 'monthly', amountMinor: 1 },
      { plan: 'growth', mode: 'monthly', referralCode: 'bad space' },
    ])
      expect(
        (
          await validate(plainToInstance(PlanSelectionDto, body), {
            whitelist: true,
            forbidNonWhitelisted: true,
          })
        ).length,
      ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(EmptyReferralDto, { userId: 'victim' }),
          {
            forbidUnknownValues: false,
            whitelist: true,
            forbidNonWhitelisted: true,
          },
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
describe('account referrals service boundaries', () => {
  function harness() {
    const db = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'active', emailVerifiedAt: new Date() }),
      },
      referralCode: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      referralAttribution: { count: jest.fn().mockResolvedValue(0) },
      referralLedgerEntry: { groupBy: jest.fn().mockResolvedValue([]) },
      referralAudit: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = {
      ...db,
      $transaction: jest.fn((fn: (tx: typeof db) => unknown) => fn(db)),
    };
    const limits = { consume: jest.fn().mockResolvedValue(undefined) };
    const service = new ReferralsService(
      prisma as unknown as PrismaService,
      new ReferralVault(config),
      new ReferralCursor(config),
      limits as unknown as AuthenticatedRateLimitService,
    );
    return { db, prisma, service, limits };
  }
  it('reads an honest empty ledger without manufacturing records', async () => {
    const { service, db } = harness();
    expect(await service.summary('u')).toEqual({
      code: null,
      firstPaymentRateBps: 1000,
      referredCount: 0,
      conversions: 0,
      earnings: [],
    });
    expect(db.referralCode.create).not.toHaveBeenCalled();
    expect(db.referralAudit.create).not.toHaveBeenCalled();
  });
  it('reuses an existing code and rejects unverified accounts', async () => {
    const { service, db } = harness();
    const vault = new ReferralVault(config);
    const token = vault.generate();
    db.referralCode.findUnique.mockResolvedValue({
      id: 'code',
      status: 'active',
      tokenHash: referralHash(token),
      encryptedToken: vault.encrypt('code', token),
    });
    expect(await service.createCode('u')).toEqual({ code: token });
    expect(db.referralCode.create).not.toHaveBeenCalled();
    db.user.findUnique.mockResolvedValue({
      status: 'active',
      emailVerifiedAt: null,
    });
    await expect(service.createCode('u')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('does not return invented zero balances on database or rate-limit failure', async () => {
    const { service, db, limits } = harness();
    db.referralLedgerEntry.groupBy.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(service.summary('u')).rejects.toThrow('database unavailable');
    limits.consume.mockRejectedValue(new Error('Redis unavailable'));
    await expect(service.createCode('u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('rejects custom-quote checkout and invalid plan modes before mutation', async () => {
    const { service, prisma } = harness();
    await expect(
      service.selectPlan('u', { plan: 'efficient', mode: 'annually' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('keeps settlement disabled until explicit product approval and provider integration', async () => {
    const engine = new ReferralSettlementService({} as PrismaService, config);
    await expect(
      engine.processVerifiedEvent({
        kind: 'refund',
        provider: 'test',
        eventId: 'event',
        providerPaymentId: 'payment',
        payloadDigest: 'a'.repeat(64),
        cumulativeRefundMinor: 1n,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('queries audit by explicit own-account scope and returns no other-party identifiers', async () => {
    const prisma = {
      referralAudit: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const audit = new ReferralAuditService(
      prisma as unknown as PrismaService,
      new ReferralCursor(config),
    );
    await audit.queryForAccount('user1', { event: 'referral.plan_selected' });
    expect(prisma.referralAudit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subjectUserId: 'user1', eventType: 'referral.plan_selected' },
        select: { id: true, eventType: true, createdAt: true, metadata: true },
        take: 26,
      }),
    );
  });
});
