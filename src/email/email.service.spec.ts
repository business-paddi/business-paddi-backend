import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { EmailService } from './email.service';

jest.mock('resend', () => ({ Resend: jest.fn() }));

interface SentEmail {
  subject?: string;
  attachments?: { filename: string; contentId: string; contentType: string }[];
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
  ['sendEmailVerification', 'Verify your BusinessPaddi email'],
  ['sendLoginVerification', 'Complete your BusinessPaddi login'],
  ['sendEmailChangeVerification', 'Confirm your new BusinessPaddi email'],
  ['sendEmailChangedNotice', 'Your BusinessPaddi email was changed'],
  ['sendPasswordResetCode', 'Reset your BusinessPaddi password'],
  ['sendPasswordResetNotice', 'Your BusinessPaddi password was reset'],
  ['sendSensitiveActionCode', 'Confirm your BusinessPaddi security change'],
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
    expect(html).toContain('YOUR BUSINESS, CONNECTED');
    expect(html).toContain('cid:business-paddi-logo');
    expect(html).toContain('#216e98');
    expect(html).toContain('border:1px solid #dce5ed');
    expect(html).toContain('lang=');
    expect(sent[0].attachments).toEqual([
      expect.objectContaining({
        contentId: 'business-paddi-logo',
        contentType: 'image/png',
      }),
    ]);
    if (
      method !== 'sendEmailChangedNotice' &&
      method !== 'sendPasswordResetNotice'
    ) {
      expect(html).toContain('monospace');
      expect(html).toContain('123456');
    }
  });
});
