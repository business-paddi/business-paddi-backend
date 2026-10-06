import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class LoginRateLimitService {
  private readonly pepper: string;
  private readonly windowSeconds: number;
  private readonly maxAttemptsPerIp: number;
  private readonly maxAttemptsPerAccount: number;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.pepper =
      configService.get<string>('RATE_LIMIT_PEPPER') ??
      configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
    this.windowSeconds = this.positiveInteger(
      configService.get<string>('LOGIN_RATE_LIMIT_WINDOW_SECONDS'),
      15 * 60,
    );
    this.maxAttemptsPerIp = this.positiveInteger(
      configService.get<string>('LOGIN_RATE_LIMIT_IP_MAX'),
      30,
    );
    this.maxAttemptsPerAccount = this.positiveInteger(
      configService.get<string>('LOGIN_RATE_LIMIT_ACCOUNT_MAX'),
      8,
    );
  }

  async consumeLoginAttempt(
    normalizedEmail: string,
    sourceIdentifier: string,
  ): Promise<void> {
    const result = await this.redis.client.eval(
      `
        local ipCount = redis.call('INCR', KEYS[1])
        if ipCount == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end

        local accountCount = redis.call('INCR', KEYS[2])
        if accountCount == 1 then
          redis.call('EXPIRE', KEYS[2], ARGV[1])
        end

        return { ipCount, accountCount }
      `,
      {
        keys: [this.ipKey(sourceIdentifier), this.accountKey(normalizedEmail)],
        arguments: [this.windowSeconds.toString()],
      },
    );

    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      typeof result[0] !== 'number' ||
      typeof result[1] !== 'number'
    ) {
      throw new Error('Redis returned an invalid login rate-limit response');
    }

    if (
      result[0] > this.maxAttemptsPerIp ||
      result[1] > this.maxAttemptsPerAccount
    ) {
      throw new HttpException(
        'Too many login attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async resetAccountLimit(normalizedEmail: string): Promise<void> {
    await this.redis.client.del(this.accountKey(normalizedEmail));
  }

  private ipKey(sourceIdentifier: string): string {
    return `rate-limit:login:ip:${this.fingerprint(`ip:${sourceIdentifier}`)}`;
  }

  private accountKey(normalizedEmail: string): string {
    return `rate-limit:login:account:${this.fingerprint(
      `account:${normalizedEmail}`,
    )}`;
  }

  private fingerprint(value: string): string {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  private positiveInteger(value: string | undefined, fallback: number): number {
    if (value === undefined) {
      return fallback;
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid rate-limit configuration value: ${value}`);
    }

    return parsed;
  }
}
