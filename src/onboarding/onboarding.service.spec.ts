import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import type { RequestLocationContext } from '../location/location.service';
import { OnboardingService } from './onboarding.service';

const context = {
  requestMetadata: { ipAddress: null, requestId: 'req-1', userAgent: null },
  location: { city: null, region: null, country: null },
} as unknown as RequestLocationContext;

function setup() {
  const findUnique = jest.fn();
  const upsert = jest.fn();
  const deleteMany = jest.fn();
  const createBusiness = jest.fn(
    (arg: { data: { ownerId: string; name: string } }): Promise<unknown> =>
      Promise.resolve(arg),
  );
  const createManyInvites = jest.fn();
  const findManyInvites = jest.fn();
  const transaction = {
    onboardingDraft: { findUnique, upsert, deleteMany },
    business: { create: createBusiness },
    staffInvite: { createMany: createManyInvites, findMany: findManyInvites },
  };
  const recorded: unknown[] = [];
  const record = jest.fn((event: unknown) => {
    recorded.push(event);
    return Promise.resolve(undefined);
  });
  const transact = jest.fn(
    async (fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction),
  );
  const prisma = {
    ...transaction,
    $transaction: transact,
  } as unknown as PrismaService;
  const audit = { record } as unknown as AuditService;
  const service = new OnboardingService(prisma, audit);
  return {
    service,
    recorded,
    mocks: {
      findUnique,
      upsert,
      createBusiness,
      createManyInvites,
      findManyInvites,
      transact,
    },
  };
}

describe('OnboardingService', () => {
  it('returns null when no draft exists', async () => {
    const { service, mocks } = setup();
    mocks.findUnique.mockResolvedValue(null);
    await expect(service.getDraft('user-1')).resolves.toBeNull();
  });

  it('normalizes stored JSON into the draft shape', async () => {
    const { service, mocks } = setup();
    mocks.findUnique.mockResolvedValue({
      userId: 'user-1',
      business: { name: 'Acme', industry: null, address: null },
      staff: [{ name: 'Ada', email: 'ada@example.com', role: 'admin' }],
    });
    await expect(service.getDraft('user-1')).resolves.toEqual({
      business: { name: 'Acme', industry: null, address: null },
      staff: [{ name: 'Ada', email: 'ada@example.com', role: 'admin' }],
    });
  });

  it('rejects an empty patch', async () => {
    const { service } = setup();
    await expect(service.saveDraft('user-1', {}, context)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects duplicate staff emails', async () => {
    const { service, mocks } = setup();
    mocks.findUnique.mockResolvedValue(null);
    await expect(
      service.saveDraft(
        'user-1',
        {
          staff: [
            { name: 'A', email: 'dup@example.com', role: 'admin' },
            { name: 'B', email: 'dup@example.com', role: 'staff' },
          ],
        },
        context,
      ),
    ).rejects.toThrow('Staff email addresses must be unique');
  });

  it('merges patch sections and audits the save', async () => {
    const { service, mocks, recorded } = setup();
    mocks.findUnique.mockResolvedValue({
      userId: 'user-1',
      business: { name: 'Acme', industry: 'Retail', address: null },
      staff: [],
    });
    const result = await service.saveDraft(
      'user-1',
      { staff: [{ name: 'Ada', email: 'ada@example.com', role: 'admin' }] },
      context,
    );
    expect(result).toEqual({
      business: { name: 'Acme', industry: 'Retail', address: null },
      staff: [{ name: 'Ada', email: 'ada@example.com', role: 'admin' }],
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: 'account.onboarding.draft_saved',
      userId: 'user-1',
    });
  });

  it('refuses to complete without a business name', async () => {
    const { service, mocks } = setup();
    mocks.findUnique.mockResolvedValue({
      userId: 'user-1',
      business: { industry: 'Retail' },
      staff: [],
    });
    await expect(service.completeOnboarding('user-1', context)).rejects.toThrow(
      'Onboarding is incomplete',
    );
    expect(mocks.transact).not.toHaveBeenCalled();
  });

  it('creates business + invites, clears draft, and audits completion', async () => {
    const { service, mocks, recorded } = setup();
    mocks.findUnique.mockResolvedValue({
      userId: 'user-1',
      business: { name: 'Acme', industry: 'Retail', address: null },
      staff: [{ name: 'Ada', email: 'ada@example.com', role: 'admin' }],
    });
    mocks.createBusiness.mockResolvedValue({
      id: 'biz-1',
      name: 'Acme',
      industry: 'Retail',
      address: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    mocks.findManyInvites.mockResolvedValue([
      {
        id: 'inv-1',
        name: 'Ada',
        email: 'ada@example.com',
        role: 'admin',
        status: 'pending',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const result = await service.completeOnboarding('user-1', context);
    expect(result.message).toBe('Onboarding completed successfully');
    expect(result.business).toMatchObject({ id: 'biz-1', name: 'Acme' });
    expect(result.invites).toHaveLength(1);
    expect(mocks.createBusiness).toHaveBeenCalledTimes(1);
    expect(mocks.createBusiness.mock.calls[0][0].data).toMatchObject({
      ownerId: 'user-1',
      name: 'Acme',
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: 'account.onboarding.completed',
    });
  });
});
