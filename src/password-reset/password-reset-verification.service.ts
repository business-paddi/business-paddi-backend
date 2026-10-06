import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

interface PasswordResetPayload {
  userId: string | null;
}

export type PasswordResetVerificationResult =
  | ({ status: 'verified' } & PasswordResetPayload)
  | { status: 'invalid' | 'expired' | 'attempts-exhausted' };

export interface IssuedPasswordResetChallenge {
  challengeId: string;
  code: string;
  deliveryId: string;
}

@Injectable()
export class PasswordResetVerificationService {
  private static readonly CHALLENGE_TTL_SECONDS = 10 * 60;
  private static readonly CODE_TTL_SECONDS = 5 * 60;
  private static readonly COOLDOWN_SECONDS = 60;
  private static readonly ISSUE_WINDOW_SECONDS = 15 * 60;
  private static readonly MAX_ISSUES_PER_IP = 10;
  private static readonly MAX_ISSUES_PER_ACCOUNT = 5;
  private static readonly MAX_VERIFY_ATTEMPTS = 5;

  private readonly pepper: string;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.pepper = configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
  }

  async issue(
    accountIdentifier: string,
    userId: string | null,
    requesterIp: string,
  ): Promise<IssuedPasswordResetChallenge> {
    const account = this.fingerprint(accountIdentifier);
    await this.enforceIssueLimits(account, requesterIp);

    const challengeId = randomUUID();
    const subject = this.fingerprint(challengeId);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const activeKey = this.activeKey(account);
    const previousSubject = await this.redis.client.get(activeKey);
    const transaction = this.redis.client.multi();

    if (previousSubject) {
      transaction.del([
        this.challengeKey(previousSubject),
        this.codeKey(previousSubject),
        this.attemptsKey(previousSubject),
        this.challengeAccountKey(previousSubject),
      ]);
    }
    await transaction
      .set(
        this.challengeKey(subject),
        JSON.stringify({ userId } satisfies PasswordResetPayload),
        { EX: PasswordResetVerificationService.CHALLENGE_TTL_SECONDS },
      )
      .set(this.codeKey(subject), this.codeDigest(subject, code), {
        EX: PasswordResetVerificationService.CODE_TTL_SECONDS,
      })
      .set(activeKey, subject, {
        EX: PasswordResetVerificationService.CHALLENGE_TTL_SECONDS,
      })
      .set(this.challengeAccountKey(subject), account, {
        EX: PasswordResetVerificationService.CHALLENGE_TTL_SECONDS,
      })
      .del(this.attemptsKey(subject))
      .exec();

    return { challengeId, code, deliveryId: randomUUID() };
  }

  async consume(
    challengeId: string,
    code: string,
  ): Promise<PasswordResetVerificationResult> {
    const subject = this.fingerprint(challengeId);
    const result = await this.redis.client.eval(
      `
        local payload = redis.call('GET', KEYS[1])
        local storedCode = redis.call('GET', KEYS[2])
        local account = redis.call('GET', KEYS[4])
        if not account then return 'expired' end
        local activeKey = 'password-reset:active:' .. account
        local activeSubject = redis.call('GET', activeKey)
        if not payload or not storedCode or activeSubject ~= ARGV[4] then
          return 'expired'
        end

        local attempts = redis.call('INCR', KEYS[3])
        if attempts == 1 then redis.call('EXPIRE', KEYS[3], ARGV[2]) end
        if attempts > tonumber(ARGV[3]) then
          redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], activeKey)
          return 'attempts-exhausted'
        end

        if storedCode ~= ARGV[1] then return 'invalid' end
        redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], activeKey)
        return payload
      `,
      {
        keys: [
          this.challengeKey(subject),
          this.codeKey(subject),
          this.attemptsKey(subject),
          this.challengeAccountKey(subject),
        ],
        arguments: [
          this.codeDigest(subject, code),
          PasswordResetVerificationService.CODE_TTL_SECONDS.toString(),
          PasswordResetVerificationService.MAX_VERIFY_ATTEMPTS.toString(),
          subject,
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
      throw new Error('Redis returned an invalid password-reset response');
    }

    const payload = this.parsePayload(result);
    return { status: 'verified', ...payload };
  }

  async invalidate(challengeId: string): Promise<void> {
    const subject = this.fingerprint(challengeId);
    await this.redis.client.eval(
      `
        local account = redis.call('GET', KEYS[4])
        redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
        if account then
          local activeKey = 'password-reset:active:' .. account
          if redis.call('GET', activeKey) == ARGV[1] then
            redis.call('DEL', activeKey)
          end
        end
        return 1
      `,
      {
        keys: [
          this.challengeKey(subject),
          this.codeKey(subject),
          this.attemptsKey(subject),
          this.challengeAccountKey(subject),
        ],
        arguments: [subject],
      },
    );
  }

  private async enforceIssueLimits(
    account: string,
    requesterIp: string,
  ): Promise<void> {
    const result = await this.redis.client.eval(
      `
        local ipCount = redis.call('INCR', KEYS[1])
        if ipCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        local accountCount = redis.call('INCR', KEYS[2])
        if accountCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
        local acquired = redis.call('SET', KEYS[3], '1', 'EX', ARGV[4], 'NX')
        if ipCount > tonumber(ARGV[2]) or
           accountCount > tonumber(ARGV[3]) or not acquired then
          return 0
        end
        return 1
      `,
      {
        keys: [
          `password-reset:issue-ip:${this.fingerprint(requesterIp)}`,
          `password-reset:issue-account:${account}`,
          `password-reset:cooldown:${account}`,
        ],
        arguments: [
          PasswordResetVerificationService.ISSUE_WINDOW_SECONDS.toString(),
          PasswordResetVerificationService.MAX_ISSUES_PER_IP.toString(),
          PasswordResetVerificationService.MAX_ISSUES_PER_ACCOUNT.toString(),
          PasswordResetVerificationService.COOLDOWN_SECONDS.toString(),
        ],
      },
    );

    if (result !== 1) {
      throw new HttpException(
        'Please wait before requesting another password-reset code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private parsePayload(value: string): PasswordResetPayload {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'userId' in parsed &&
        (typeof parsed.userId === 'string' || parsed.userId === null)
      ) {
        return { userId: parsed.userId };
      }
    } catch {
      // Return a protocol-safe internal error below.
    }
    throw new Error('Redis returned an invalid password-reset payload');
  }

  private fingerprint(value: string): string {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  private codeDigest(subject: string, code: string): string {
    return createHmac('sha256', this.pepper)
      .update(`password-reset:${subject}:${code}`)
      .digest('hex');
  }

  private challengeKey(subject: string): string {
    return `password-reset:challenge:${subject}`;
  }

  private codeKey(subject: string): string {
    return `password-reset:code:${subject}`;
  }

  private attemptsKey(subject: string): string {
    return `password-reset:attempts:${subject}`;
  }

  private activeKey(account: string): string {
    return `password-reset:active:${account}`;
  }

  private challengeAccountKey(subject: string): string {
    return `password-reset:challenge-account:${subject}`;
  }
}
