import {
  brandedEmail,
  escapeHtml,
  type BrandedEmailContent,
} from '../email/email-layout';
export type InvitationEmailPayload = BrandedEmailContent & {
  from: string;
  to: string;
  subject: string;
};
export function invitationEmail(input: {
  from: string;
  to: string;
  business: string;
  role: string;
  url: string;
  expiresAt: Date;
  requiresApproval: boolean;
}): InvitationEmailPayload {
  const business = escapeHtml(input.business);
  const role = escapeHtml(input.role);
  const url = escapeHtml(input.url);
  const expiry = input.expiresAt
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
  const approval = input.requiresApproval
    ? 'After you accept, a business administrator will review your membership before workspace access is granted.'
    : 'Accept your invitation to join the business workspace.';
  return {
    from: input.from,
    to: input.to,
    subject: `You're invited to ${input.business.replace(/[\r\n]/g, ' ').slice(0, 120)} on BusinessPaddi`,
    ...brandedEmail({
      title: `You're invited to ${input.business}`,
      preheader: `You've been invited to ${input.business} on BusinessPaddi.`,
      bodyHtml: `<p style="font-size:16px;line-height:1.7;color:#43546c">You've been invited to join <strong>${business}</strong> as <strong>${role}</strong>. ${approval}</p><table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0"><tr><td bgcolor="#216e98" style="border-radius:8px"><a href="${url}" style="display:inline-block;padding:16px 24px;color:#fff;text-decoration:none;font-size:16px;font-weight:bold">View invitation</a></td></tr></table><p style="font-size:14px;line-height:1.6;color:#43546c">Already have an account? Sign in with <strong>${escapeHtml(input.to)}</strong>.<br>New to BusinessPaddi? Create an account with this email, verify it, then return to your invitation to accept.</p><p style="font-size:13px;color:#52647a;line-height:1.6">This invitation expires ${expiry}. If the button doesn't work, open:<br><a href="${url}" style="color:#216e98;word-break:break-all">${url}</a></p>`,
      text: `You're invited to ${input.business}\n\nJoin as ${input.role}. ${approval}\n\nView invitation: ${input.url}\n\nAlready have an account? Sign in with ${input.to}. New to BusinessPaddi? Create an account with that email, verify it, then return to your invitation to accept.\nThis invitation expires ${expiry}.`,
      footer:
        "If you weren't expecting this invitation, you can ignore this email.",
    }),
  };
}
