import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

export type VerificationResult =
  'verified' | 'invalid' | 'expired' | 'attempts-exhausted';

interface IssuedVerificationCode {
  code: string;
  deliveryId: string;
}

@Injectable()
export class VerificationCodeService {
  private static readonly CODE_TTL_SECONDS = 5 * 60;
  private static readonly RESEND_COOLDOWN_SECONDS = 60;
  private static readonly MAX_VERIFY_ATTEMPTS = 5;
  private static readonly ISSUE_WINDOW_SECONDS = 15 * 60;
  private static readonly MAX_ISSUES_PER_IP_WINDOW = 10;

  private readonly pepper: string;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.pepper = configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
  }

  async issueEmailCode(
    email: string,
    requesterIp: string,
  ): Promise<IssuedVerificationCode> {
    await this.enforceIpIssueLimit(requesterIp);

    const subject = this.fingerprint(`email:${email}`);
    const cooldownKey = this.cooldownKey(subject);
    const acquired = await this.redis.client.set(cooldownKey, '1', {
      EX: VerificationCodeService.RESEND_COOLDOWN_SECONDS,
      NX: true,
    });

    if (acquired !== 'OK') {
      throw new HttpException(
        'Please wait before requesting another verification code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const digest = this.codeDigest(subject, code);

    await this.redis.client
      .multi()
      .set(this.codeKey(subject), digest, {
        EX: VerificationCodeService.CODE_TTL_SECONDS,
      })
      .del(this.attemptsKey(subject))
      .exec();

    return {
      code,
      deliveryId: randomUUID(),
    };
  }

  async consumeEmailCode(
    email: string,
    code: string,
  ): Promise<VerificationResult> {
    const subject = this.fingerprint(`email:${email}`);
    const result = await this.redis.client.eval(
      `
        local stored = redis.call('GET', KEYS[1])
        if not stored then
          return -1
        end

        local attempts = redis.call('INCR', KEYS[2])
        if attempts == 1 then
          redis.call('EXPIRE', KEYS[2], ARGV[2])
        end

        if attempts > tonumber(ARGV[3]) then
          redis.call('DEL', KEYS[1])
          return -2
        end

        if stored == ARGV[1] then
          redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
          return 1
        end

        return 0
      `,
      {
        keys: [
          this.codeKey(subject),
          this.attemptsKey(subject),
          this.cooldownKey(subject),
        ],
        arguments: [
          this.codeDigest(subject, code),
          VerificationCodeService.CODE_TTL_SECONDS.toString(),
          VerificationCodeService.MAX_VERIFY_ATTEMPTS.toString(),
        ],
      },
    );

    switch (result) {
      case 1:
        return 'verified';
      case -1:
        return 'expired';
      case -2:
        return 'attempts-exhausted';
      default:
        return 'invalid';
    }
  }

  async invalidateEmailCode(email: string): Promise<void> {
    const subject = this.fingerprint(`email:${email}`);
    await this.redis.client.del([
      this.codeKey(subject),
      this.attemptsKey(subject),
      this.cooldownKey(subject),
    ]);
  }

  private async enforceIpIssueLimit(requesterIp: string): Promise<void> {
    const key = `verification:email:issue-ip:${this.fingerprint(requesterIp)}`;
    const result = await this.redis.client.eval(
      `
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return count
      `,
      {
        keys: [key],
        arguments: [VerificationCodeService.ISSUE_WINDOW_SECONDS.toString()],
      },
    );

    if (typeof result !== 'number') {
      throw new Error('Redis returned an invalid rate-limit response');
    }

    if (result > VerificationCodeService.MAX_ISSUES_PER_IP_WINDOW) {
      throw new HttpException(
        'Too many verification-code requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private fingerprint(value: string): string {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  private codeDigest(subject: string, code: string): string {
    return createHmac('sha256', this.pepper)
      .update(`email:${subject}:${code}`)
      .digest('hex');
  }

  private codeKey(subject: string): string {
    return `verification:email:code:${subject}`;
  }

  private attemptsKey(subject: string): string {
    return `verification:email:attempts:${subject}`;
  }

  private cooldownKey(subject: string): string {
    return `verification:email:cooldown:${subject}`;
  }
}
