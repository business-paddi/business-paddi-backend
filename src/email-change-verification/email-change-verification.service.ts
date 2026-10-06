import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

interface EmailChangePayload {
  userId: string;
  newEmail: string;
}

export type EmailChangeVerificationResult =
  | ({ status: 'verified' } & EmailChangePayload)
  | { status: 'invalid' | 'expired' | 'attempts-exhausted' };

@Injectable()
export class EmailChangeVerificationService {
  private static readonly CHALLENGE_TTL_SECONDS = 10 * 60;
  private static readonly CODE_TTL_SECONDS = 5 * 60;
  private static readonly COOLDOWN_SECONDS = 60;
  private static readonly MAX_ATTEMPTS = 5;
  private readonly pepper: string;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.pepper = configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
  }

  async issue(
    userId: string,
    newEmail: string,
  ): Promise<{ challengeId: string; code: string; deliveryId: string }> {
    const userKey = `email-change:user-cooldown:${this.fingerprint(userId)}`;
    const acquired = await this.redis.client.set(userKey, '1', {
      EX: EmailChangeVerificationService.COOLDOWN_SECONDS,
      NX: true,
    });
    if (acquired !== 'OK') {
      throw new HttpException(
        'Please wait before requesting another email-change code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const challengeId = randomUUID();
    const subject = this.fingerprint(challengeId);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.redis.client
      .multi()
      .set(
        this.challengeKey(subject),
        JSON.stringify({ userId, newEmail } satisfies EmailChangePayload),
        { EX: EmailChangeVerificationService.CHALLENGE_TTL_SECONDS },
      )
      .set(this.codeKey(subject), this.codeDigest(subject, code), {
        EX: EmailChangeVerificationService.CODE_TTL_SECONDS,
      })
      .del(this.attemptsKey(subject))
      .exec();

    return { challengeId, code, deliveryId: randomUUID() };
  }

  async consume(
    challengeId: string,
    code: string,
  ): Promise<EmailChangeVerificationResult> {
    const subject = this.fingerprint(challengeId);
    const result = await this.redis.client.eval(
      `
        local payload = redis.call('GET', KEYS[1])
        local stored = redis.call('GET', KEYS[2])
        if not payload or not stored then return 'expired' end
        local attempts = redis.call('INCR', KEYS[3])
        if attempts == 1 then redis.call('EXPIRE', KEYS[3], ARGV[2]) end
        if attempts > tonumber(ARGV[3]) then
          redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
          return 'attempts-exhausted'
        end
        if stored ~= ARGV[1] then return 'invalid' end
        redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
        return payload
      `,
      {
        keys: [
          this.challengeKey(subject),
          this.codeKey(subject),
          this.attemptsKey(subject),
        ],
        arguments: [
          this.codeDigest(subject, code),
          EmailChangeVerificationService.CODE_TTL_SECONDS.toString(),
          EmailChangeVerificationService.MAX_ATTEMPTS.toString(),
        ],
      },
    );

    if (
      result === 'invalid' ||
      result === 'expired' ||
      result === 'attempts-exhausted'
    ) {
      return { status: result };
    }
    if (typeof result !== 'string') {
      throw new Error('Redis returned an invalid email-change response');
    }

    try {
      const payload: unknown = JSON.parse(result);
      if (
        !this.isRecord(payload) ||
        typeof payload.userId !== 'string' ||
        typeof payload.newEmail !== 'string'
      ) {
        throw new Error();
      }
      return {
        status: 'verified',
        userId: payload.userId,
        newEmail: payload.newEmail,
      };
    } catch {
      throw new Error('Redis returned an invalid email-change payload');
    }
  }

  async invalidate(challengeId: string): Promise<void> {
    const subject = this.fingerprint(challengeId);
    await this.redis.client.del([
      this.challengeKey(subject),
      this.codeKey(subject),
      this.attemptsKey(subject),
    ]);
  }

  private fingerprint(value: string): string {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  private codeDigest(subject: string, code: string): string {
    return createHmac('sha256', this.pepper)
      .update(`email-change:${subject}:${code}`)
      .digest('hex');
  }

  private challengeKey(subject: string): string {
    return `email-change:challenge:${subject}`;
  }

  private codeKey(subject: string): string {
    return `email-change:code:${subject}`;
  }

  private attemptsKey(subject: string): string {
    return `email-change:attempts:${subject}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
