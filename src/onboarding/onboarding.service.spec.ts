import { BadRequestException } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service';
import type { RecordAuditEventInput } from '../audit/audit-event.types';
import type { PrismaService } from '../database/prisma.service';
import type { RequestLocationContext } from '../location/location.service';
import { OnboardingService } from './onboarding.service';

const context = { requestMetadata: {}, location: {} } as RequestLocationContext;
const defaults = {
  desktopNotifications: true,
  twoFactorEnabled: true,
  onboardingUseCases: [] as string[],
  onboardingUsage: null as string | null,
  onboardingReferralSource: null as string | null,
  onboardingReferralDetails: null as string | null,
  onboardingCompletedAt: null as Date | null,
};

function setup(overrides: Partial<typeof defaults> = {}) {
  const current = { ...defaults, ...overrides };
  const userPreference = {
    findUnique: jest.fn().mockResolvedValue(current),
    findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...current })),
    upsert: jest.fn().mockResolvedValue(current),
    update: jest.fn(({ data }: { data: Partial<typeof defaults> }) => {
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) Object.assign(current, { [key]: value });
      }
      return Promise.resolve({ ...current });
    }),
    updateMany: jest.fn(({ data }: { data: Partial<typeof defaults> }) => {
      if (current.onboardingCompletedAt) return Promise.resolve({ count: 0 });
      Object.assign(current, data);
      return Promise.resolve({ count: 1 });
    }),
  };
  const transaction = { userPreference, $queryRaw: jest.fn() };
  const prisma = {
    userPreference,
    $transaction: jest.fn(
      async (callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  const audit = {
    record: jest
      .fn<Promise<void>, [RecordAuditEventInput, unknown?]>()
      .mockResolvedValue(undefined),
  };
  const service = new OnboardingService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, prisma, audit, current, transaction };
}

describe('Onboarding preference flow', () => {
  it('returns empty optional answers when no preference row exists', async () => {
    const { service, prisma } = setup();
    prisma.userPreference.findUnique.mockResolvedValue(null);
    await expect(service.getDraft('u1')).resolves.toEqual({
      useCases: [],
      usage: null,
      referralSource: null,
      referralDetails: null,
      completedAt: null,
    });
  });

  it('rejects an empty patch before writing', async () => {
    const { service, prisma } = setup();
    await expect(service.saveDraft('u1', {}, context)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('merges supplied preferences and preserves security settings and omitted answers', async () => {
    const { service, current, transaction } = setup({
      onboardingUsage: 'employee',
    });
    const result = await service.saveDraft(
      'u1',
      { useCases: ['personal_records'] },
      context,
    );
    expect(result.usage).toBe('employee');
    expect(result.useCases).toEqual(['personal_records']);
    expect(current.twoFactorEnabled).toBe(true);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('records referral changes with the preference write transaction', async () => {
    const { service, audit, transaction } = setup();
    await service.saveDraft(
      'u1',
      { referralSource: 'other', referralDetails: 'Community group' },
      context,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'account.referral.updated',
        userId: 'u1',
        metadata: {
          previousSource: null,
          source: 'other',
          details: 'Community group',
        },
      }),
      transaction,
    );
  });

  it('does not create duplicate referral events for unchanged answers', async () => {
    const { service, audit } = setup({
      onboardingReferralSource: 'search_engine',
    });
    await service.saveDraft('u1', { referralSource: 'search_engine' }, context);
    expect(audit.record.mock.calls.map(([event]) => event.eventType)).toEqual([
      'account.onboarding.preferences_updated',
    ]);
  });

  it('clears stale details when the source changes and audits clearing', async () => {
    const { service, audit } = setup({
      onboardingReferralSource: 'other',
      onboardingReferralDetails: 'Forum',
    });
    const result = await service.saveDraft(
      'u1',
      { referralSource: null },
      context,
    );
    expect(result.referralSource).toBeNull();
    expect(result.referralDetails).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'account.referral.updated',
        metadata: { previousSource: 'other', source: null, details: null },
      }),
      expect.anything(),
    );
  });

  it('rejects referral details without the other source', async () => {
    const { service, prisma } = setup();
    await expect(
      service.saveDraft('u1', { referralDetails: 'A forum' }, context),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.userPreference.update).not.toHaveBeenCalled();
  });

  it('allows skipping every question, retains answers, and completes idempotently', async () => {
    const { service, audit } = setup();
    const first = await service.completeOnboarding('u1', context);
    const second = await service.completeOnboarding('u1', context);
    expect(first.onboarding.completedAt).toBeInstanceOf(Date);
    expect(second.onboarding).toEqual(first.onboarding);
    expect(first.onboarding.useCases).toEqual([]);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'account.onboarding.completed' }),
      expect.anything(),
    );
  });

  it('allows edits after completion without resetting completion', async () => {
    const completedAt = new Date('2026-10-07T00:00:00Z');
    const { service } = setup({ onboardingCompletedAt: completedAt });
    const result = await service.saveDraft('u1', { usage: 'team' }, context);
    expect(result.completedAt).toEqual(completedAt);
    expect(result.usage).toBe('team');
  });

  it('propagates audit failure so the database transaction can roll back', async () => {
    const { service, audit } = setup();
    audit.record.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      service.saveDraft('u1', { usage: 'personal' }, context),
    ).rejects.toThrow('audit unavailable');
  });
});
