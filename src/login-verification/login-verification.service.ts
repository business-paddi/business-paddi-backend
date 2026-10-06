import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

export type LoginChallengeResult =
  | {
      status: 'verified';
      userId: string;
      authenticationMethod: PendingAuthenticationMethod;
    }
  | { status: 'invalid' | 'expired' | 'attempts-exhausted' };

export type PendingAuthenticationMethod = 'password' | 'google';

export interface IssuedLoginChallenge {
  challengeId: string;
  code: string;
  deliveryId: string;
  userId: string;
  authenticationMethod: PendingAuthenticationMethod;
}

interface StoredLoginChallenge {
  userId: string;
  authenticationMethod: PendingAuthenticationMethod;
}

@Injectable()
export class LoginVerificationService {
  private static readonly CHALLENGE_TTL_SECONDS = 10 * 60;
  private static readonly CODE_TTL_SECONDS = 5 * 60;
  private static readonly RESEND_COOLDOWN_SECONDS = 60;
  private static readonly MAX_VERIFY_ATTEMPTS = 5;
  private static readonly ISSUE_WINDOW_SECONDS = 15 * 60;
  private static readonly MAX_ISSUES_PER_IP_WINDOW = 10;
  private static readonly MAX_ISSUES_PER_USER_WINDOW = 5;

  private readonly pepper: string;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.pepper = configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
  }

  async issueChallenge(
    userId: string,
    requesterIp: string,
    authenticationMethod: PendingAuthenticationMethod = 'password',
  ): Promise<IssuedLoginChallenge> {
    await this.enforceIssueLimits(userId, requesterIp);

    const challengeId = randomUUID();
    const subject = this.fingerprint(challengeId);
    await this.redis.client.set(
      this.challengeKey(subject),
      JSON.stringify({ userId, authenticationMethod }),
      { EX: LoginVerificationService.CHALLENGE_TTL_SECONDS },
    );

    try {
      const issued = await this.issueCode(subject);
      return { challengeId, userId, authenticationMethod, ...issued };
    } catch (error: unknown) {
      await this.invalidateChallenge(challengeId);
      throw error;
    }
  }

  async resendChallenge(
    challengeId: string,
    requesterIp: string,
  ): Promise<IssuedLoginChallenge | null> {
    const subject = this.fingerprint(challengeId);
    const storedValue = await this.redis.client.get(this.challengeKey(subject));

    if (!storedValue) {
      return null;
    }

    const stored = this.parseChallenge(storedValue);

    await this.enforceIssueLimits(stored.userId, requesterIp);
    const issued = await this.issueCode(subject);
    return { challengeId, ...stored, ...issued };
  }

  async consumeChallenge(
    challengeId: string,
    code: string,
  ): Promise<LoginChallengeResult> {
    const subject = this.fingerprint(challengeId);
    const result = await this.redis.client.eval(
      `
        local challenge = redis.call('GET', KEYS[1])
        local storedCode = redis.call('GET', KEYS[2])
        if not challenge or not storedCode then
          return 'expired'
        end

        local attempts = redis.call('INCR', KEYS[3])
        if attempts == 1 then
          redis.call('EXPIRE', KEYS[3], ARGV[2])
        end

        if attempts > tonumber(ARGV[3]) then
          redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
          return 'attempts-exhausted'
        end

        if storedCode == ARGV[1] then
          redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
          return challenge
        end

        return 'invalid'
      `,
      {
        keys: [
          this.challengeKey(subject),
          this.codeKey(subject),
          this.attemptsKey(subject),
          this.cooldownKey(subject),
        ],
        arguments: [
          this.codeDigest(subject, code),
          LoginVerificationService.CODE_TTL_SECONDS.toString(),
          LoginVerificationService.MAX_VERIFY_ATTEMPTS.toString(),
        ],
      },
    );

    if (result === 'invalid' || result === 'expired') {
      return { status: result };
    }

    if (result === 'attempts-exhausted') {
      return { status: 'attempts-exhausted' };
    }

    if (typeof result !== 'string' || !result) {
      throw new Error('Redis returned an invalid login-verification response');
    }

    return { status: 'verified', ...this.parseChallenge(result) };
  }

  async invalidateChallenge(challengeId: string): Promise<void> {
    const subject = this.fingerprint(challengeId);
    await this.redis.client.del([
      this.challengeKey(subject),
      this.codeKey(subject),
      this.attemptsKey(subject),
      this.cooldownKey(subject),
    ]);
  }

  async invalidateCode(challengeId: string): Promise<void> {
    const subject = this.fingerprint(challengeId);
    await this.redis.client.del([
      this.codeKey(subject),
      this.attemptsKey(subject),
      this.cooldownKey(subject),
    ]);
  }

  private async issueCode(
    subject: string,
  ): Promise<{ code: string; deliveryId: string }> {
    const acquired = await this.redis.client.set(
      this.cooldownKey(subject),
      '1',
      {
        EX: LoginVerificationService.RESEND_COOLDOWN_SECONDS,
        NX: true,
      },
    );

    if (acquired !== 'OK') {
      throw new HttpException(
        'Please wait before requesting another login code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.redis.client
      .multi()
      .set(this.codeKey(subject), this.codeDigest(subject, code), {
        EX: LoginVerificationService.CODE_TTL_SECONDS,
      })
      .del(this.attemptsKey(subject))
      .exec();

    return { code, deliveryId: randomUUID() };
  }

  private parseChallenge(value: string): StoredLoginChallenge {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).userId === 'string' &&
        ((parsed as Record<string, unknown>).authenticationMethod ===
          'password' ||
          (parsed as Record<string, unknown>).authenticationMethod === 'google')
      ) {
        return parsed as StoredLoginChallenge;
      }
    } catch {
      if (value) {
        return { userId: value, authenticationMethod: 'password' };
      }
    }

    throw new Error('Redis returned an invalid login challenge');
  }

  private async enforceIssueLimits(
    userId: string,
    requesterIp: string,
  ): Promise<void> {
    const result = await this.redis.client.eval(
      `
        local ipCount = redis.call('INCR', KEYS[1])
        if ipCount == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end

        local userCount = redis.call('INCR', KEYS[2])
        if userCount == 1 then
          redis.call('EXPIRE', KEYS[2], ARGV[1])
        end

        if ipCount > tonumber(ARGV[2]) or userCount > tonumber(ARGV[3]) then
          return { ipCount, userCount, 0 }
        end

        local acquired = redis.call('SET', KEYS[3], '1', 'EX', ARGV[4], 'NX')
        if not acquired then
          return { ipCount, userCount, 0 }
        end

        return { ipCount, userCount, 1 }
      `,
      {
        keys: [
          `login-verification:issue-ip:${this.fingerprint(requesterIp)}`,
          `login-verification:issue-user:${this.fingerprint(userId)}`,
          `login-verification:user-cooldown:${this.fingerprint(userId)}`,
        ],
        arguments: [
          LoginVerificationService.ISSUE_WINDOW_SECONDS.toString(),
          LoginVerificationService.MAX_ISSUES_PER_IP_WINDOW.toString(),
          LoginVerificationService.MAX_ISSUES_PER_USER_WINDOW.toString(),
          LoginVerificationService.RESEND_COOLDOWN_SECONDS.toString(),
        ],
      },
    );

    if (
      !Array.isArray(result) ||
      result.length !== 3 ||
      typeof result[0] !== 'number' ||
      typeof result[1] !== 'number' ||
      typeof result[2] !== 'number'
    ) {
      throw new Error('Redis returned an invalid rate-limit response');
    }

    if (result[2] !== 1) {
      throw new HttpException(
        'Please wait before requesting another login code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private fingerprint(value: string): string {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  private codeDigest(subject: string, code: string): string {
    return createHmac('sha256', this.pepper)
      .update(`login:${subject}:${code}`)
      .digest('hex');
  }

  private challengeKey(subject: string): string {
    return `login-verification:challenge:${subject}`;
  }

  private codeKey(subject: string): string {
    return `login-verification:code:${subject}`;
  }

  private attemptsKey(subject: string): string {
    return `login-verification:attempts:${subject}`;
  }

  private cooldownKey(subject: string): string {
    return `login-verification:cooldown:${subject}`;
  }
}
