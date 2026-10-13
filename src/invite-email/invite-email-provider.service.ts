import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { InvitationEmailPayload } from './invitation-email.template';

export class EmailDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

@Injectable()
export class InviteEmailProvider {
  private readonly client: Resend;
  constructor(config: ConfigService) {
    this.client = new Resend(config.getOrThrow<string>('RESEND_KEY'));
  }

  async send(
    payload: InvitationEmailPayload,
    idempotencyKey: string,
  ): Promise<string> {
    let result: Awaited<ReturnType<Resend['emails']['send']>>;
    try {
      result = await this.client.emails.send(payload, {
        idempotencyKey,
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new EmailDeliveryError('PROVIDER_NETWORK_ERROR', true);
    }
    if (result.error) {
      const status = result.error.statusCode;
      const concurrent = result.error.name === 'concurrent_idempotent_requests';
      throw new EmailDeliveryError(
        `RESEND_${result.error.name}`,
        concurrent || status === 429 || status == null || status >= 500,
      );
    }
    if (!result.data?.id)
      throw new EmailDeliveryError('PROVIDER_EMPTY_RESPONSE', true);
    return result.data.id;
  }
}
