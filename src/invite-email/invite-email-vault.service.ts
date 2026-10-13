import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import type { InvitationEmailPayload } from './invitation-email.template';

@Injectable()
export class InviteEmailVault {
  private readonly key: Buffer;
  constructor(config: ConfigService) {
    this.key = createHmac(
      'sha256',
      config.getOrThrow<string>('VERIFICATION_CODE_PEPPER'),
    )
      .update('business-paddi/invite-email/encryption/v1')
      .digest();
  }
  encrypt(id: string, payload: InvitationEmailPayload): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      nonce.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }
  decrypt(id: string, envelope: string): InvitationEmailPayload {
    const [version, nonce, tag, content] = envelope.split('.');
    if (version !== 'v1' || !nonce || !tag || !content)
      throw new Error('Invalid invitation email envelope');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(nonce, 'base64url'),
    );
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const text = Buffer.concat([
      decipher.update(Buffer.from(content, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(text) as InvitationEmailPayload;
  }
}
