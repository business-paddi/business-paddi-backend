import { ConfigService } from '@nestjs/config';
import { invitationEmail } from './invitation-email.template';
import { InviteEmailVault } from './invite-email-vault.service';
import { InvitePermissionsService } from '../business/invite-permissions.service';

describe('Invitation email and grant policy', () => {
  const payload = invitationEmail({
    from: 'BusinessPaddi <test@example.invalid>',
    to: 'ada@example.invalid',
    business: '<script> & Store\r\nBcc: bad',
    role: 'Manager <Admin>',
    url: 'https://example.invalid/business-invites?token=secret&inviteId=1',
    expiresAt: new Date('2026-10-18T10:00:00Z'),
    requiresApproval: true,
  });
  it('escapes HTML and headers, includes accessible logo, expiry and text alternative', () => {
    expect(payload.html).not.toContain('<script>');
    expect(payload.html).toContain('&lt;script&gt; &amp; Store');
    expect(payload.subject).not.toMatch(/[\r\n]/);
    expect(payload.html).toContain('lang="en"');
    expect(payload.html).toContain('cid:business-paddi-logo');
    expect(payload.attachments[0].contentType).toBe('image/png');
    expect(payload.text).toContain('review your membership');
    expect(payload.text).toContain('2026-10-18');
  });
  it('encrypts the entire frozen message and authenticates its delivery ID', () => {
    const vault = new InviteEmailVault(
      new ConfigService({ VERIFICATION_CODE_PEPPER: 'a'.repeat(32) }),
    );
    const encrypted = vault.encrypt('d1', payload);
    expect(encrypted).not.toContain('secret');
    expect(encrypted).not.toContain('ada@');
    expect(vault.decrypt('d1', encrypted)).toEqual(payload);
    expect(() => vault.decrypt('d2', encrypted)).toThrow();
    expect(() =>
      vault.decrypt('d1', encrypted.slice(0, -6) + 'aaaaaa'),
    ).toThrow();
  });
  it('compares effective permission sets including explicit denials', () => {
    const policy = new InvitePermissionsService();
    const role = {
      permissions: [
        { permission: 'members:view' },
        { permission: 'inventory:manage' },
      ],
      deniedPermissions: [{ permission: 'inventory:manage' }],
    } as never;
    expect(policy.missingGrants(['members:view'], role)).toEqual([]);
    expect(policy.missingGrants([], role)).toEqual(['members:view']);
    expect(() => policy.requireAssignable([], role)).toThrow();
  });
});
