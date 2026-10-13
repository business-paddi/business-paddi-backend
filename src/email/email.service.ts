import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { accountEmail, type AccountEmailKind } from './account-email.template';

interface CodeEmailInput {
  to: string;
  code: string;
  idempotencyKey: string;
}

@Injectable()
export class EmailService {
  private readonly resend: Resend;
  private readonly from: string;
  constructor(config: ConfigService) {
    this.resend = new Resend(config.getOrThrow<string>('RESEND_KEY'));
    this.from = config.getOrThrow<string>('RESEND_FROM_EMAIL');
  }

  sendEmailVerification(input: CodeEmailInput): Promise<void> {
    return this.send(
      'verify_email',
      input.to,
      'Unable to send the verification email',
      input,
    );
  }
  sendLoginVerification(input: CodeEmailInput): Promise<void> {
    return this.send(
      'verify_login',
      input.to,
      'Unable to send the login email',
      input,
    );
  }
  sendEmailChangeVerification(input: CodeEmailInput): Promise<void> {
    return this.send(
      'verify_email_change',
      input.to,
      'Unable to send the email-change verification',
      input,
    );
  }
  sendEmailChangedNotice(to: string): Promise<void> {
    return this.send(
      'email_changed',
      to,
      'Unable to send the email-change notice',
    );
  }
  sendPasswordResetCode(input: CodeEmailInput): Promise<void> {
    return this.send(
      'reset_password',
      input.to,
      'Unable to send the password-reset email',
      input,
    );
  }
  sendPasswordResetNotice(to: string): Promise<void> {
    return this.send(
      'password_reset',
      to,
      'Unable to send the password-reset notice',
    );
  }
  sendSensitiveActionCode(input: CodeEmailInput): Promise<void> {
    return this.send(
      'verify_security',
      input.to,
      'Unable to send the security verification email',
      input,
    );
  }

  private async send(
    kind: AccountEmailKind,
    to: string,
    errorMessage: string,
    input?: CodeEmailInput,
  ): Promise<void> {
    const payload = { from: this.from, to, ...accountEmail(kind, input?.code) };
    const { error } = await this.resend.emails.send(
      payload,
      input ? { idempotencyKey: input.idempotencyKey } : undefined,
    );
    if (error) throw new ServiceUnavailableException(errorMessage);
  }
}
