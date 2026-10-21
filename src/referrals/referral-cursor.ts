import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
@Injectable()
export class ReferralCursor {
  constructor(private readonly config: ConfigService) {}
  private signature(scope: string, value: string) {
    return createHmac(
      'sha256',
      this.config.getOrThrow<string>('VERIFICATION_CODE_PEPPER'),
    )
      .update(`referrals/cursor/v1:${scope}:${value}`)
      .digest();
  }
  encode(scope: string, row: { id: string; createdAt: Date }) {
    const value = Buffer.from(
      JSON.stringify({ id: row.id, at: row.createdAt.toISOString() }),
    ).toString('base64url');
    return `${value}.${this.signature(scope, value).toString('base64url')}`;
  }
  decode(
    scope: string,
    cursor?: string,
  ): { id: string; createdAt: Date } | undefined {
    if (!cursor) return;
    try {
      const [value, mac, extra] = cursor.split('.');
      if (!value || !mac || extra || cursor.length > 1000) throw new Error();
      const actual = Buffer.from(mac, 'base64url');
      const expected = this.signature(scope, value);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const data = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
        id?: unknown;
        at?: unknown;
      };
      if (
        typeof data.id !== 'string' ||
        data.id.length > 100 ||
        typeof data.at !== 'string' ||
        new Date(data.at).toISOString() !== data.at
      )
        throw new Error();
      return { id: data.id, createdAt: new Date(data.at) };
    } catch {
      throw new BadRequestException('Invalid or expired pagination cursor.');
    }
  }
}
