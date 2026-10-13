import { Module } from '@nestjs/common';
import { InviteEmailVault } from './invite-email-vault.service';
import { InviteEmailProvider } from './invite-email-provider.service';
import { InviteEmailOutbox } from './invite-email-outbox.service';
import { InviteEmailDeliveryService } from './invite-email-delivery.service';
import { InviteEmailQueue } from './invite-email-queue.service';

@Module({
  providers: [
    InviteEmailVault,
    InviteEmailProvider,
    InviteEmailOutbox,
    InviteEmailDeliveryService,
    InviteEmailQueue,
  ],
  exports: [InviteEmailOutbox],
})
export class InviteEmailModule {}
