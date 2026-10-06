import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class SensitiveActionRateLimitService {
  private static readonly WINDOW_SECONDS = 15 * 60;
  private static readonly MAX_PER_USER = 10;
  private static readonly MAX_PER_SESSION = 10;
  private static readonly MAX_PER_IP = 30;
  private readonly pepper: string;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.pepper =
      configService.get<string>('RATE_LIMIT_PEPPER') ??
      configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
  }

  async consume(userId: string, sessionId: string, ip: string): Promise<void> {
    const result = await this.redis.client.eval(
      `
        local counts = {}
        for index, key in ipairs(KEYS) do
          counts[index] = redis.call('INCR', key)
          if counts[index] == 1 then redis.call('EXPIRE', key, ARGV[1]) end
        end
        return counts
      `,
      {
        keys: [
          this.key('user', userId),
          this.key('session', sessionId),
          this.key('ip', ip),
        ],
        arguments: [SensitiveActionRateLimitService.WINDOW_SECONDS.toString()],
      },
    );
    if (
      !Array.isArray(result) ||
      result.length !== 3 ||
      result.some((value) => typeof value !== 'number')
    ) {
      throw new Error(
        'Redis returned an invalid sensitive rate-limit response',
      );
    }
    const counts = result as number[];
    if (
      counts[0] > SensitiveActionRateLimitService.MAX_PER_USER ||
      counts[1] > SensitiveActionRateLimitService.MAX_PER_SESSION ||
      counts[2] > SensitiveActionRateLimitService.MAX_PER_IP
    ) {
      throw new HttpException(
        'Too many security verification attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async reset(userId: string, sessionId: string): Promise<void> {
    await this.redis.client.del([
      this.key('user', userId),
      this.key('session', sessionId),
    ]);
  }

  private key(kind: string, value: string): string {
    return `rate-limit:sensitive:${kind}:${createHmac('sha256', this.pepper).update(value).digest('hex')}`;
  }
}
