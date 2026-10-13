import { brandedEmail, escapeHtml } from './email-layout';

export type AccountEmailKind =
  | 'verify_email'
  | 'verify_login'
  | 'verify_email_change'
  | 'email_changed'
  | 'reset_password'
  | 'password_reset'
  | 'verify_security';
const copy = {
  verify_email: {
    subject: 'Verify your BusinessPaddi email',
    title: 'Verify your email address',
    description:
      'Welcome to BusinessPaddi. Use this code to verify your email address and get started.',
    codeLabel: 'Email verification code',
    footer: 'If you did not request this code, you can ignore this email.',
  },
  verify_login: {
    subject: 'Complete your BusinessPaddi login',
    title: 'Complete your sign-in',
    description:
      'Use this code to finish signing in to your BusinessPaddi account.',
    codeLabel: 'Sign-in verification code',
    footer:
      'If you did not try to sign in, change your password and review your sessions.',
  },
  verify_email_change: {
    subject: 'Confirm your new BusinessPaddi email',
    title: 'Confirm your new email address',
    description:
      'Use this code to confirm the new email address for your BusinessPaddi account.',
    codeLabel: 'Email-change verification code',
    footer:
      'If you did not request this change, secure your account immediately.',
  },
  email_changed: {
    subject: 'Your BusinessPaddi email was changed',
    title: 'Your email address was changed',
    description: 'The email address on your BusinessPaddi account was changed.',
    codeLabel: null,
    footer: 'If this was not you, contact support immediately.',
  },
  reset_password: {
    subject: 'Reset your BusinessPaddi password',
    title: 'Reset your password',
    description: 'Use this code to reset your BusinessPaddi password.',
    codeLabel: 'Password-reset code',
    footer:
      'If you did not request a password reset, you can ignore this email and review your sessions.',
  },
  password_reset: {
    subject: 'Your BusinessPaddi password was reset',
    title: 'Your password was reset',
    description:
      'Your BusinessPaddi password was reset and all existing sessions were signed out.',
    codeLabel: null,
    footer: 'If this was not you, contact support immediately.',
  },
  verify_security: {
    subject: 'Confirm your BusinessPaddi security change',
    title: 'Confirm your security change',
    description:
      'Use this code to confirm the requested security change to your BusinessPaddi account.',
    codeLabel: 'Security verification code',
    footer:
      'If you did not request a security change, review your sessions immediately.',
  },
} satisfies Record<
  AccountEmailKind,
  {
    subject: string;
    title: string;
    description: string;
    codeLabel: string | null;
    footer: string;
  }
>;

export function accountEmail(kind: AccountEmailKind, code?: string) {
  const message = copy[kind];
  if (message.codeLabel && !code)
    throw new Error('Verification email requires a code');
  const codeHtml = message.codeLabel
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0"><tr><td style="background:#f0f6fa;border:1px solid #dce5ed;border-radius:8px;padding:24px;text-align:center"><p style="margin:0 0 12px;color:#52647a;font-size:12px">${escapeHtml(message.codeLabel)}</p><p style="margin:0;color:#216e98;font-size:32px;font-weight:700;letter-spacing:8px;font-family:monospace">${escapeHtml(code!)}</p></td></tr></table><p style="font-size:14px;line-height:1.6;color:#43546c">This code expires in <strong>5 minutes</strong>. Enter it on the screen where you requested it. Never share your verification code.</p>`
    : '';
  return {
    subject: message.subject,
    ...brandedEmail({
      title: message.title,
      preheader: `${message.subject}.${message.codeLabel ? ' Code expires in 5 minutes.' : ''}`,
      bodyHtml: `<p style="font-size:16px;line-height:1.7;color:#43546c">${escapeHtml(message.description)}</p>${codeHtml}`,
      text: `${message.title}\n\n${message.description}${message.codeLabel ? `\n\n${message.codeLabel}: ${code}\nThis code expires in 5 minutes. Enter it on the screen where you requested it. Never share your verification code.` : ''}`,
      footer: message.footer,
    }),
  };
}
