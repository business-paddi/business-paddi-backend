import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
export const referralHash = (code: string) =>
  createHash('sha256').update(code).digest('hex');
@Injectable()
export class ReferralVault {
  private readonly key: Buffer;
  constructor(config: ConfigService) {
    this.key = createHmac(
      'sha256',
      config.getOrThrow<string>('VERIFICATION_CODE_PEPPER'),
    )
      .update('business-paddi/referral-code/encryption/v1')
      .digest();
  }
  generate() {
    return randomBytes(24).toString('base64url');
  }
  encrypt(id: string, code: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const body = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      body.toString('base64url'),
    ].join('.');
  }
  decrypt(id: string, envelope: string) {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1')
      throw new Error('Invalid referral envelope');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(parts[1], 'base64url'),
    );
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
