import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
import { InviteEmailVault } from './invite-email-vault.service';
import {
  EmailDeliveryError,
  InviteEmailProvider,
} from './invite-email-provider.service';
import { InviteEmailDeliveryService } from './invite-email-delivery.service';
import { invitationEmail } from './invitation-email.template';
import { SAFE_RETRY_WINDOW_MS } from './invite-email.constants';

describe('Durable invitation email delivery', () => {
  const vault = new InviteEmailVault(
    new ConfigService({ VERIFICATION_CODE_PEPPER: 'a'.repeat(32) }),
  );
  const payload = invitationEmail({
    from: 'test@example.invalid',
    to: 'ada@example.invalid',
    business: 'Store',
    role: 'Employee',
    url: 'https://example.invalid/?token=secret',
    expiresAt: new Date('2030-01-01'),
    requiresApproval: false,
  });
  const provider = { send: jest.fn() };
  let row: Record<string, unknown>;
  const invite = {
    id: 'i',
    status: 'pending',
    expiresAt: new Date('2030-01-01'),
    deliveryGeneration: 1,
  };
  const updateMany = jest.fn(
    ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (Object.entries(where).some(([key, value]) => row[key] !== value))
        return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  );
  const db = {
    $queryRaw: jest.fn(),
    inviteEmailDelivery: {
      findUnique: jest.fn(() => ({ ...row, invite })),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const { attempts, ...rest } = data;
        Object.assign(row, rest);
        if (attempts) row.attempts = Number(row.attempts) + 1;
        return { ...row };
      }),
      updateMany,
    },
    businessInvite: { update: jest.fn(), updateMany: jest.fn() },
  };
  const service = new InviteEmailDeliveryService(
    {
      $transaction: async (callback: (db: unknown) => Promise<unknown>) =>
        callback(db),
    } as unknown as PrismaService,
    vault,
    provider as unknown as InviteEmailProvider,
  );
  beforeEach(() => {
    jest.clearAllMocks();
    provider.send.mockResolvedValue('resend-1');
    row = {
      id: 'd',
      inviteId: 'i',
      generation: 1,
      state: 'pending',
      attempts: 0,
      firstAttemptAt: null,
      nextAttemptAt: new Date(0),
      leaseId: null,
      leaseExpiresAt: null,
      payloadCiphertext: vault.encrypt('d', payload),
    };
    invite.status = 'pending';
  });
  it('does not send an already delivered message again', async () => {
    await service.deliver('d');
    await service.deliver('d');
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(row.state).toBe('sent');
    expect(row.payloadCiphertext).toBeNull();
    expect(provider.send).toHaveBeenCalledWith(payload, 'business-invite/d');
  });
  it('does not send when another worker owns the database lease', async () => {
    Object.assign(row, {
      state: 'processing',
      leaseId: 'other',
      leaseExpiresAt: new Date(Date.now() + 120000),
    });
    await service.deliver('d');
    expect(provider.send).not.toHaveBeenCalled();
  });
  it('retries transient provider failures with identical payload and key', async () => {
    provider.send.mockRejectedValueOnce(
      new EmailDeliveryError('RESEND_RATE_LIMITED', true),
    );
    await expect(service.deliver('d')).rejects.toThrow('RESEND_RATE_LIMITED');
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    row.nextAttemptAt = new Date(0);
    await service.deliver('d');
    expect(provider.send.mock.calls[0]).toEqual(provider.send.mock.calls[1]);
    expect(row.state).toBe('sent');
  });
  it('recovers after provider success followed by a failed database commit', async () => {
    updateMany.mockRejectedValueOnce(
      new Error('Database unavailable') as never,
    );
    await expect(service.deliver('d')).rejects.toThrow('Database unavailable');
    expect(row.state).toBe('processing');
    row.leaseExpiresAt = new Date(0);
    await service.deliver('d');
    expect(provider.send.mock.calls[0]).toEqual(provider.send.mock.calls[1]);
    expect(row.state).toBe('sent');
  });
  it('stops permanent provider errors', async () => {
    provider.send.mockRejectedValueOnce(
      new EmailDeliveryError('RESEND_VALIDATION_ERROR', false),
    );
    await service.deliver('d');
    await service.deliver('d');
    expect(row.state).toBe('failed');
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it('never retries after the safe provider idempotency window', async () => {
    Object.assign(row, {
      attempts: 1,
      firstAttemptAt: new Date(Date.now() - SAFE_RETRY_WINDOW_MS - 1),
    });
    await service.deliver('d');
    expect(row.state).toBe('uncertain');
    expect(provider.send).not.toHaveBeenCalled();
  });
  it('cancels a revoked invitation before sending', async () => {
    invite.status = 'revoked';
    await service.deliver('d');
    expect(row.state).toBe('cancelled');
    expect(provider.send).not.toHaveBeenCalled();
  });
  it('does not automatically resend an exhausted ambiguous delivery', async () => {
    Object.assign(row, { attempts: 6, firstAttemptAt: new Date() });
    await service.deliver('d');
    expect(row.state).toBe('uncertain');
    expect(provider.send).not.toHaveBeenCalled();
  });
});
