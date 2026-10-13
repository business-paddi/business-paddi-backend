import { writeFile } from 'node:fs/promises';
import {
  accountEmail,
  type AccountEmailKind,
} from '../src/email/account-email.template';
import { escapeHtml } from '../src/email/email-layout';
import { BUSINESS_PADDI_LOGO_BASE64 } from '../src/email/business-paddi-logo';
import { invitationEmail } from '../src/invite-email/invitation-email.template';

async function main() {
  const inlineLogo = (html: string) =>
    html.replace(
      'cid:business-paddi-logo',
      `data:image/png;base64,${BUSINESS_PADDI_LOGO_BASE64}`,
    );
  const invitation = invitationEmail({
    from: 'BusinessPaddi <hello@example.invalid>',
    to: 'ada@example.invalid',
    business: 'Acme Studio',
    role: 'Finance manager',
    url: 'http://localhost:3000/dashboard/invites?inviteId=preview',
    expiresAt: new Date('2030-01-08T10:00:00Z'),
    requiresApproval: true,
  });
  const kinds: AccountEmailKind[] = [
    'verify_email',
    'verify_login',
    'verify_email_change',
    'email_changed',
    'reset_password',
    'password_reset',
    'verify_security',
  ];
  const examples = [
    { subject: invitation.subject, html: inlineLogo(invitation.html) },
    ...kinds.map((kind) => {
      const email = accountEmail(kind, '123456');
      return { subject: email.subject, html: inlineLogo(email.html) };
    }),
  ];
  await writeFile('docs/invite-email-preview.html', examples[0].html, 'utf8');
  await writeFile(
    'docs/email-previews.html',
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BusinessPaddi email previews</title></head><body style="margin:0;padding:24px;background:#f4f7fa;color:#0f1f3d;font-family:Arial,Helvetica,sans-serif"><h1>BusinessPaddi email previews</h1><p>Invitation and account emails using the shared brand template.</p><main style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,560px),1fr));gap:24px">${examples.map((email) => `<section><h2 style="font-size:18px">${escapeHtml(email.subject)}</h2><iframe sandbox title="${escapeHtml(email.subject)}" srcdoc="${escapeHtml(email.html)}" style="width:100%;height:760px;border:1px solid #dce5ed;border-radius:12px;background:#fff"></iframe></section>`).join('')}</main></body></html>`,
    'utf8',
  );
  console.log('Rendered eight email previews.');
}
void main();
