import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

interface SendEmailVerificationInput {
  to: string;
  code: string;
  idempotencyKey: string;
}

interface SendLoginVerificationInput {
  to: string;
  code: string;
  idempotencyKey: string;
}

interface SendEmailChangeInput {
  to: string;
  code: string;
  idempotencyKey: string;
}

interface SendPasswordResetInput {
  to: string;
  code: string;
  idempotencyKey: string;
}

interface SendSensitiveActionInput {
  to: string;
  code: string;
  idempotencyKey: string;
}

const CODE_STYLE =
  'font-size:32px;font-weight:700;letter-spacing:8px;font-family:monospace;text-align:center';

function preheader(text: string): string {
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${text}</div>`;
}

function codeBlock(code: string): string {
  return `<p style="${CODE_STYLE}">${code}</p>`;
}

@Injectable()
export class EmailService {
  private readonly resend: Resend;
  private readonly from: string;

  constructor(configService: ConfigService) {
    this.resend = new Resend(configService.getOrThrow<string>('RESEND_KEY'));
    this.from = configService.getOrThrow<string>('RESEND_FROM_EMAIL');
  }

  async sendBusinessInvitation(input: {
    to: string;
    url: string;
    idempotencyKey: string;
  }): Promise<void> {
    const { error } = await this.resend.emails.send(
      {
        from: this.from,
        to: input.to,
        subject: 'Your Business Paddi business invitation',
        text: `You have been invited to a business on Business Paddi. Sign in with this email address and accept your invitation: ${input.url}\nThis invitation expires in seven days. If you were not expecting it, you can ignore it.`,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (error)
      throw new ServiceUnavailableException(
        'Unable to send the invitation email',
      );
  }

  async sendEmailVerification(
    input: SendEmailVerificationInput,
  ): Promise<void> {
    const { error } = await this.resend.emails.send(
      {
        from: this.from,
        to: input.to,
        subject: 'Verify your Business Paddi email',
        text: `Your Business Paddi verification code is ${input.code}. It expires in 5 minutes.`,
        html: [
          preheader(
            'Your Business Paddi verification code. It expires in 5 minutes.',
          ),
          '<h1 style="font-size:20px;font-weight:700;">Your Business Paddi verification code is:</h1>',
          codeBlock(input.code),
          '<p style="font-size:16px;">This code expires in 5 minutes. If you did not request it, you can ignore this email.</p>',
        ].join(''),
      },
      { idempotencyKey: input.idempotencyKey },
    );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to send the verification email',
      );
    }
  }

  async sendLoginVerification(
    input: SendLoginVerificationInput,
  ): Promise<void> {
    const { error } = await this.resend.emails.send(
      {
        from: this.from,
        to: input.to,
        subject: 'Complete your Business Paddi login',
        text: `Your Business Paddi login code is ${input.code}. It expires in 5 minutes.`,
        html: [
          preheader('Your Business Paddi login code. It expires in 5 minutes.'),
          '<h1 style="font-size:20px;font-weight:700;">Your Business Paddi login code is:</h1>',
          codeBlock(input.code),
          '<p style="font-size:16px;">This code expires in 5 minutes. If you did not try to sign in, change your password.</p>',
        ].join(''),
      },
      { idempotencyKey: input.idempotencyKey },
    );

    if (error) {
      throw new ServiceUnavailableException('Unable to send the login email');
    }
  }

  async sendEmailChangeVerification(
    input: SendEmailChangeInput,
  ): Promise<void> {
    const { error } = await this.resend.emails.send(
      {
        from: this.from,
        to: input.to,
        subject: 'Confirm your new Business Paddi email',
        text: `Your Business Paddi email-change code is ${input.code}. It expires in 5 minutes.`,
        html: [
          preheader('Confirm your new Business Paddi email address.'),
          '<h1 style="font-size:20px;font-weight:700;">Your Business Paddi email-change code is:</h1>',
          codeBlock(input.code),
          '<p style="font-size:16px;">This code expires in 5 minutes. If you did not request this change, secure your account.</p>',
        ].join(''),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (error) {
      throw new ServiceUnavailableException(
        'Unable to send the email-change verification',
      );
    }
  }

  async sendEmailChangedNotice(to: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Your Business Paddi email was changed',
      text: 'The email address on your Business Paddi account was changed. If this was not you, contact support immediately.',
      html: [
        preheader('Your Business Paddi account email was changed.'),
        '<h1 style="font-size:20px;font-weight:700;">Your Business Paddi email was changed</h1>',
        '<p style="font-size:16px;">The email address on your Business Paddi account was changed. If this was not you, contact support immediately.</p>',
      ].join(''),
    });
    if (error) {
      throw new ServiceUnavailableException(
        'Unable to send the email-change notice',
      );
    }
  }

  async sendPasswordResetCode(input: SendPasswordResetInput): Promise<void> {
    const { error } = await this.resend.emails.send(
      {
        from: this.from,
        to: input.to,
        subject: 'Reset your Business Paddi password',
        text: `Your Business Paddi password-reset code is ${input.code}. It expires in 5 minutes.`,
        html: [
          preheader(
            'Reset your Business Paddi password. Code expires in 5 minutes.',
          ),
          '<h1 style="font-size:20px;font-weight:700;">Your Business Paddi password-reset code is:</h1>',
          codeBlock(input.code),
          '<p style="font-size:16px;">This code expires in 5 minutes. If you did not request it, you can ignore this email and review your sessions.</p>',
        ].join(''),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (error) {
      throw new ServiceUnavailableException(
        'Unable to send the password-reset email',
      );
    }
  }

  async sendPasswordResetNotice(to: string): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject: 'Your Business Paddi password was reset',
      text: 'Your Business Paddi password was reset and all existing sessions were signed out. If this was not you, contact support immediately.',
      html: [
        preheader('Your Business Paddi password was reset.'),
        '<h1 style="font-size:20px;font-weight:700;">Your Business Paddi password was reset</h1>',
        '<p style="font-size:16px;">Your Business Paddi password was reset and all existing sessions were signed out. If this was not you, contact support immediately.</p>',
      ].join(''),
    });
    if (error) {
      throw new ServiceUnavailableException(
        'Unable to send the password-reset notice',
      );
    }
  }

  async sendSensitiveActionCode(
    input: SendSensitiveActionInput,
  ): Promise<void> {
    const { error } = await this.resend.emails.send(
      {
        from: this.from,
        to: input.to,
        subject: 'Confirm your Business Paddi security change',
        text: `Your Business Paddi security verification code is ${input.code}. It expires in 5 minutes.`,
        html: [
          preheader('Confirm your Business Paddi security change.'),
          '<h1 style="font-size:20px;font-weight:700;">Your Business Paddi security verification code is:</h1>',
          codeBlock(input.code),
          '<p style="font-size:16px;">This code expires in 5 minutes. If you did not request a security change, review your sessions immediately.</p>',
        ].join(''),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (error) {
      throw new ServiceUnavailableException(
        'Unable to send the security verification email',
      );
    }
  }
}
