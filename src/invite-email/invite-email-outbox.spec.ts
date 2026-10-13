import { ConfigService } from '@nestjs/config';
import type { BusinessInvite } from '../../generated/prisma/client';
import { InviteEmailOutbox } from './invite-email-outbox.service';
import { InviteEmailVault } from './invite-email-vault.service';

describe('Invitation dashboard email links', () => {
  const invite = {
    id: 'invite-123',
    businessId: 'b',
    roleId: 'r',
    email: 'ada@example.invalid',
    deliveryGeneration: 1,
    expiresAt: new Date('2030-01-01'),
    requiresApproval: false,
  } as BusinessInvite;
  const db = {
    business: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Test business' }),
    },
    role: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Employee' }),
    },
    inviteEmailDelivery: { create: jest.fn() },
  };
  it.each([undefined, '/custom/invites'])(
    'uses dashboard route or configured path %s without exposing a token',
    async (path) => {
      const config = new ConfigService({
        VERIFICATION_CODE_PEPPER: 'a'.repeat(32),
        FRONTEND_URL: 'https://businesspaddi.com',
        RESEND_FROM_EMAIL: 'test@example.invalid',
        ...(path ? { INVITE_FRONTEND_PATH: path } : {}),
      });
      const vault = new InviteEmailVault(config);
      await new InviteEmailOutbox(config, vault).record(db as never, invite);
      const { data } = (
        db.inviteEmailDelivery.create.mock.calls as unknown[][]
      ).at(-1)![0] as { data: { id: string; payloadCiphertext: string } };
      const payload = vault.decrypt(data.id, data.payloadCiphertext);
      expect(payload.text).toContain(
        `https://businesspaddi.com${path ?? '/dashboard/invites'}?inviteId=invite-123`,
      );
      expect(payload.html).not.toContain('token=');
      expect(payload.text).toContain('Create an account');
    },
  );
});
