import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EmailService } from './email.service';

jest.mock('resend', () => ({ Resend: jest.fn() }));

interface SentEmail {
  subject?: string;
  [key: string]: unknown;
}

interface CodeInput {
  to: string;
  code: string;
  idempotencyKey: string;
}

const sent: SentEmail[] = [];

type EmailMethodName =
  | 'sendEmailVerification'
  | 'sendLoginVerification'
  | 'sendEmailChangeVerification'
  | 'sendEmailChangedNotice'
  | 'sendPasswordResetCode'
  | 'sendPasswordResetNotice'
  | 'sendSensitiveActionCode';

type NoticeMethod = 'sendEmailChangedNotice' | 'sendPasswordResetNotice';
type CodeMethod = Exclude<EmailMethodName, NoticeMethod>;

const CASES: Array<[EmailMethodName, string]> = [
  ['sendEmailVerification', 'Verify your Business Paddi email'],
  ['sendLoginVerification', 'Complete your Business Paddi login'],
  ['sendEmailChangeVerification', 'Confirm your new Business Paddi email'],
  ['sendEmailChangedNotice', 'Your Business Paddi email was changed'],
  ['sendPasswordResetCode', 'Reset your Business Paddi password'],
  ['sendPasswordResetNotice', 'Your Business Paddi password was reset'],
  ['sendSensitiveActionCode', 'Confirm your Business Paddi security change'],
];

describe('EmailService branding', () => {
  let service: EmailService;

  beforeEach(() => {
    sent.length = 0;
    (Resend as unknown as jest.Mock).mockImplementation(() => ({
      emails: {
        send: (payload: SentEmail): Promise<{ error: null }> => {
          sent.push(payload);
          return Promise.resolve({ error: null });
        },
      },
    }));
    const config = {
      getOrThrow: (key: string): string =>
        key === 'RESEND_KEY' ? 're_test' : 'Test <test@example.com>',
    } as unknown as ConfigService;
    service = new EmailService(config);
  });

  it.each(CASES)('%p uses subject %p', async (method, subject) => {
    if (
      method === 'sendEmailChangedNotice' ||
      method === 'sendPasswordResetNotice'
    ) {
      const notice: NoticeMethod = method;
      await service[notice]('user@example.com');
    } else {
      const code: CodeMethod = method;
      const input: CodeInput = {
        to: 'user@example.com',
        code: '123456',
        idempotencyKey: 'k',
      };
      await service[code](input);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(subject);
    expect(JSON.stringify(sent[0])).not.toMatch(/aurescore/i);
    const html = JSON.stringify(sent[0].html ?? '');
    expect(html).toContain('display:none');
    expect(html).toContain('<h1');
    if (
      method !== 'sendEmailChangedNotice' &&
      method !== 'sendPasswordResetNotice'
    ) {
      expect(html).toContain('monospace');
      expect(html).toContain('123456');
    }
  });
});
