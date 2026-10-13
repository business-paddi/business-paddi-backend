import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { BusinessInvite, Prisma } from '../../generated/prisma/client';
import { invitationEmail } from './invitation-email.template';
import { InviteEmailVault } from './invite-email-vault.service';

@Injectable()
export class InviteEmailOutbox {
  constructor(
    private readonly config: ConfigService,
    private readonly vault: InviteEmailVault,
  ) {}

  async record(db: Prisma.TransactionClient, invite: BusinessInvite) {
    const business = await db.business.findUniqueOrThrow({
      where: { id: invite.businessId },
      select: { name: true },
    });
    const role = await db.role.findUniqueOrThrow({
      where: { id: invite.roleId },
      select: { name: true },
    });
    const url = new URL(
      this.config.get<string>('INVITE_FRONTEND_PATH') ?? '/dashboard/invites',
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000',
    );
    url.searchParams.set('inviteId', invite.id);
    const id = randomUUID();
    const payload = invitationEmail({
      from: this.config.getOrThrow<string>('RESEND_FROM_EMAIL'),
      to: invite.email,
      business: business.name,
      role: role.name,
      url: url.toString(),
      expiresAt: invite.expiresAt,
      requiresApproval: invite.requiresApproval,
    });
    return db.inviteEmailDelivery.create({
      data: {
        id,
        inviteId: invite.id,
        generation: invite.deliveryGeneration,
        payloadCiphertext: this.vault.encrypt(id, payload),
      },
    });
  }

  async cancelPending(db: Prisma.TransactionClient, inviteId: string) {
    await db.inviteEmailDelivery.updateMany({
      where: { inviteId, state: 'pending' },
      data: { state: 'cancelled', payloadCiphertext: null },
    });
  }
}
