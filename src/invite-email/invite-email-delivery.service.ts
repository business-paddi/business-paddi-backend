import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import type { InvitationEmailPayload } from './invitation-email.template';
import { InviteEmailVault } from './invite-email-vault.service';
import {
  EmailDeliveryError,
  InviteEmailProvider,
} from './invite-email-provider.service';
import {
  MAX_EMAIL_ATTEMPTS,
  SEND_LEASE_MS,
  SAFE_RETRY_WINDOW_MS,
  deliveryIdempotencyKey,
  retryDelay,
} from './invite-email.constants';

@Injectable()
export class InviteEmailDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: InviteEmailVault,
    private readonly provider: InviteEmailProvider,
  ) {}

  async deliver(id: string): Promise<void> {
    const claimed = await this.prisma.$transaction(
      async (db) => {
        // Match the invite mutation lock order: invite, then delivery.
        await db.$queryRaw`SELECT i."id" FROM "BusinessInvite" i JOIN "InviteEmailDelivery" d ON d."inviteId" = i."id" WHERE d."id" = ${id} FOR UPDATE OF i`;
        await db.$queryRaw`SELECT "id" FROM "InviteEmailDelivery" WHERE "id" = ${id} FOR UPDATE`;
        const delivery = await db.inviteEmailDelivery.findUnique({
          where: { id },
          include: { invite: true },
        });
        const now = new Date();
        if (!delivery || !['pending', 'processing'].includes(delivery.state))
          return null;
        if (
          delivery.state === 'processing' &&
          delivery.leaseExpiresAt &&
          delivery.leaseExpiresAt > now
        )
          return null;
        if (delivery.nextAttemptAt > now) return null;
        const stale =
          delivery.invite.status !== 'pending' ||
          delivery.invite.expiresAt <= now ||
          delivery.invite.deliveryGeneration !== delivery.generation;
        const exhausted =
          delivery.attempts >= MAX_EMAIL_ATTEMPTS ||
          (delivery.firstAttemptAt &&
            now.getTime() - delivery.firstAttemptAt.getTime() >=
              SAFE_RETRY_WINDOW_MS);
        if (stale || exhausted) {
          const state = delivery.firstAttemptAt ? 'uncertain' : 'cancelled';
          await db.inviteEmailDelivery.update({
            where: { id },
            data: {
              state,
              leaseId: null,
              leaseExpiresAt: null,
              lastError: exhausted
                ? 'RETRY_WINDOW_OR_BUDGET_EXHAUSTED'
                : 'INVITATION_UNAVAILABLE',
              ...(state === 'cancelled' ? { payloadCiphertext: null } : {}),
            },
          });
          if (
            delivery.invite.deliveryGeneration === delivery.generation &&
            exhausted
          )
            await db.businessInvite.update({
              where: { id: delivery.inviteId },
              data: {
                deliveryStatus: 'failed',
                deliveryLastError: 'DELIVERY_UNCERTAIN',
              },
            });
          return null;
        }
        const leaseId = randomUUID();
        const updated = await db.inviteEmailDelivery.update({
          where: { id },
          data: {
            state: 'processing',
            leaseId,
            leaseExpiresAt: new Date(now.getTime() + SEND_LEASE_MS),
            firstAttemptAt: delivery.firstAttemptAt ?? now,
            attempts: { increment: 1 },
          },
        });
        await db.businessInvite.update({
          where: { id: delivery.inviteId },
          data: { deliveryAttempts: updated.attempts },
        });
        return updated;
      },
      { maxWait: 15000, timeout: 30000 },
    );
    if (!claimed) return;

    let providerId: string;
    try {
      if (!claimed.payloadCiphertext)
        throw new EmailDeliveryError('MISSING_ENCRYPTED_PAYLOAD', false);
      let payload: InvitationEmailPayload;
      try {
        payload = this.vault.decrypt(id, claimed.payloadCiphertext);
      } catch {
        throw new EmailDeliveryError('PAYLOAD_DECRYPTION_FAILED', false);
      }
      providerId = await this.provider.send(
        payload,
        deliveryIdempotencyKey(id),
      );
    } catch (error) {
      const failure =
        error instanceof EmailDeliveryError
          ? error
          : new EmailDeliveryError('UNKNOWN_PROVIDER_ERROR', true);
      const retry = failure.retryable && claimed.attempts < MAX_EMAIL_ATTEMPTS;
      await this.prisma.$transaction(
        async (db) => {
          await db.$queryRaw`SELECT "id" FROM "BusinessInvite" WHERE "id" = ${claimed.inviteId} FOR UPDATE`;
          const updated = await db.inviteEmailDelivery.updateMany({
            where: { id, state: 'processing', leaseId: claimed.leaseId },
            data: {
              state: retry
                ? 'pending'
                : failure.retryable
                  ? 'uncertain'
                  : 'failed',
              leaseId: null,
              leaseExpiresAt: null,
              lastError: failure.code.slice(0, 100),
              nextAttemptAt: new Date(
                Date.now() + retryDelay(claimed.attempts),
              ),
            },
          });
          if (updated.count)
            await db.businessInvite.updateMany({
              where: {
                id: claimed.inviteId,
                deliveryGeneration: claimed.generation,
              },
              data: {
                deliveryStatus: retry ? 'pending' : 'failed',
                deliveryLastError: retry
                  ? failure.code.slice(0, 100)
                  : failure.retryable
                    ? 'DELIVERY_UNCERTAIN'
                    : failure.code.slice(0, 100),
              },
            });
        },
        { maxWait: 15000, timeout: 30000 },
      );
      if (retry) throw new Error(failure.code);
      return;
    }

    // If this commit fails, the lease expires and the same immutable provider
    // payload/key is retried. Never classify a database failure as a send failure.
    await this.prisma.$transaction(
      async (db) => {
        await db.$queryRaw`SELECT "id" FROM "BusinessInvite" WHERE "id" = ${claimed.inviteId} FOR UPDATE`;
        const sentAt = new Date();
        const updated = await db.inviteEmailDelivery.updateMany({
          where: { id, state: 'processing', leaseId: claimed.leaseId },
          data: {
            state: 'sent',
            providerId,
            sentAt,
            leaseId: null,
            leaseExpiresAt: null,
            lastError: null,
            payloadCiphertext: null,
          },
        });
        if (updated.count)
          await db.businessInvite.updateMany({
            where: {
              id: claimed.inviteId,
              deliveryGeneration: claimed.generation,
            },
            data: {
              deliveryStatus: 'sent',
              deliveryProviderId: providerId,
              deliverySentAt: sentAt,
              deliveryLastError: null,
            },
          });
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
}
