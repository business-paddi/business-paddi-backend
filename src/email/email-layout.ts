import { BUSINESS_PADDI_LOGO_BASE64 } from './business-paddi-logo';

export type BrandedEmailContent = {
  html: string;
  text: string;
  attachments: {
    filename: string;
    content: string;
    contentType: string;
    contentId: string;
  }[];
};
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]!,
  );

// bodyHtml is composed by internal templates; all interpolated values must be escaped.
export function brandedEmail(input: {
  title: string;
  preheader: string;
  bodyHtml: string;
  text: string;
  footer: string;
}): BrandedEmailContent {
  return {
    html: `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title></head><body style="margin:0;background:#f4f7fa;color:#0f1f3d;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(input.preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:40px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:auto;background:#fff;border:1px solid #dce5ed;border-radius:16px"><tr><td style="padding:32px 32px 24px"><table role="presentation"><tr><td><img src="cid:business-paddi-logo" width="29" height="24" alt="BusinessPaddi logo" style="display:block"></td><td style="padding-left:10px;font-size:21px;font-weight:bold;color:#0f1f3d">BusinessPaddi</td></tr></table></td></tr><tr><td style="padding:0 32px 32px"><p style="color:#216e98;font-size:12px;font-weight:bold;letter-spacing:2px">YOUR BUSINESS, CONNECTED</p><h1 style="font-size:28px;line-height:1.25;margin:16px 0">${escapeHtml(input.title)}</h1>${input.bodyHtml}</td></tr><tr><td style="border-top:1px solid #dce5ed;padding:24px 32px;font-size:12px;color:#52647a;line-height:1.6">${escapeHtml(input.footer)}<br>BusinessPaddi · Your business, connected.</td></tr></table></td></tr></table></body></html>`,
    text: `BusinessPaddi\n\n${input.text}\n\n${input.footer}\nBusinessPaddi - Your business, connected.`,
    attachments: [
      {
        filename: 'business-paddi-logo.png',
        content: BUSINESS_PADDI_LOGO_BASE64,
        contentType: 'image/png',
        contentId: 'business-paddi-logo',
      },
    ],
  };
}
