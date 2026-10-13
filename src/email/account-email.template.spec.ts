import { accountEmail } from './account-email.template';

describe('Account email template content safety', () => {
  it('escapes values in the verification code panel', () => {
    const email = accountEmail('verify_email', '<script>alert(1)</script>');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.text).toContain('5 minutes');
    expect(email.html.match(/<h1/g)).toHaveLength(1);
  });
  it('requires a code for verification emails and omits code panels on notices', () => {
    expect(() => accountEmail('verify_login')).toThrow('requires a code');
    const notice = accountEmail('password_reset');
    expect(notice.html).not.toContain('monospace');
    expect(notice.text).toContain('all existing sessions were signed out');
    expect(notice.text).not.toContain('5 minutes');
    expect(notice.html).toContain('contact support immediately');
  });
});
