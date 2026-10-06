import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AUDIT_EVENTS } from '../audit/audit-event.types';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import type { RequestLocationContext } from '../location/location.service';
import { RedisService } from '../redis/redis.service';
import type { SensitiveAction } from './dto/request-sensitive-verification.dto';

interface ChallengePayload {
  userId: string;
  userSessionId: string;
  action: SensitiveAction;
}

@Injectable()
export class SensitiveActionVerificationService {
  private static readonly CHALLENGE_TTL = 10 * 60;
  private static readonly CODE_TTL = 5 * 60;
  private static readonly AUTHORIZATION_TTL = 5 * 60;
  private static readonly COOLDOWN = 60;
  private static readonly MAX_ATTEMPTS = 5;
  private readonly pepper: string;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    configService: ConfigService,
  ) {
    this.pepper = configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
  }

  async issue(
    userId: string,
    userSessionId: string,
    action: SensitiveAction,
    context: RequestLocationContext,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true },
    });
    if (!user || user.passwordHash) {
      throw new ForbiddenException(
        'Email security verification is available only to provider-only accounts',
      );
    }

    const owner = this.fingerprint(`${userId}:${userSessionId}:${action}`);
    const acquired = await this.redis.client.set(
      `sensitive-action:cooldown:${owner}`,
      '1',
      { EX: SensitiveActionVerificationService.COOLDOWN, NX: true },
    );
    if (acquired !== 'OK') {
      throw new HttpException(
        'Please wait before requesting another security code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const challengeId = randomUUID();
    const subject = this.fingerprint(challengeId);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const payload = {
      userId,
      userSessionId,
      action,
    } satisfies ChallengePayload;
    await this.redis.client
      .multi()
      .set(this.challengeKey(subject), JSON.stringify(payload), {
        EX: SensitiveActionVerificationService.CHALLENGE_TTL,
      })
      .set(this.codeKey(subject), this.codeDigest(subject, code), {
        EX: SensitiveActionVerificationService.CODE_TTL,
      })
      .del(this.attemptsKey(subject))
      .exec();

    try {
      await this.email.sendSensitiveActionCode({
        to: user.email,
        code,
        idempotencyKey: `sensitive-action/${randomUUID()}`,
      });
    } catch (error: unknown) {
      await this.redis.client.del([
        this.challengeKey(subject),
        this.codeKey(subject),
        this.attemptsKey(subject),
      ]);
      throw error;
    }
    await this.audit.recordBestEffort({
      eventType: AUDIT_EVENTS.SENSITIVE_VERIFICATION_CODE_SENT,
      category: 'security',
      outcome: 'success',
      userId,
      userSessionId,
      context,
      metadata: { action },
    });
    return {
      message: 'A security verification code has been sent.',
      challengeId,
    };
  }

  async verify(
    userId: string,
    userSessionId: string,
    challengeId: string,
    code: string,
  ) {
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
          SensitiveActionVerificationService.CODE_TTL.toString(),
          SensitiveActionVerificationService.MAX_ATTEMPTS.toString(),
        ],
      },
    );
    if (
      typeof result !== 'string' ||
      ['expired', 'invalid', 'attempts-exhausted'].includes(result)
    ) {
      throw new BadRequestException(
        'The security code is invalid or has expired',
      );
    }
    const payload = this.parsePayload(result);
    if (payload.userId !== userId || payload.userSessionId !== userSessionId) {
      throw new BadRequestException(
        'The security code is invalid or has expired',
      );
    }
    const authorization = randomBytes(32).toString('base64url');
    const stored = await this.redis.client.set(
      this.authorizationKey(authorization),
      JSON.stringify(payload),
      { EX: SensitiveActionVerificationService.AUTHORIZATION_TTL, NX: true },
    );
    if (stored !== 'OK')
      throw new Error('Could not store security authorization');
    return {
      reauthToken: authorization,
      expiresIn: SensitiveActionVerificationService.AUTHORIZATION_TTL,
    };
  }

  async consumeAuthorization(
    token: string | undefined,
    userId: string,
    userSessionId: string,
    action: SensitiveAction,
  ): Promise<void> {
    if (!token)
      throw new ForbiddenException('Fresh security verification is required');
    const value = await this.redis.client.getDel(this.authorizationKey(token));
    if (!value)
      throw new ForbiddenException('Fresh security verification is required');
    const payload = this.parsePayload(value);
    if (
      payload.userId !== userId ||
      payload.userSessionId !== userSessionId ||
      payload.action !== action
    ) {
      throw new ForbiddenException('Fresh security verification is required');
    }
  }

  private parsePayload(value: string): ChallengePayload {
    try {
      const payload = JSON.parse(value) as Partial<ChallengePayload>;
      if (
        typeof payload.userId === 'string' &&
        typeof payload.userSessionId === 'string' &&
        ['set-password', 'change-email', 'change-two-factor'].includes(
          payload.action ?? '',
        )
      )
        return payload as ChallengePayload;
    } catch {
      /* handled below */
    }
    throw new Error('Redis returned an invalid sensitive-action payload');
  }

  private fingerprint(value: string): string {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }
  private codeDigest(subject: string, code: string): string {
    return createHmac('sha256', this.pepper)
      .update(`sensitive:${subject}:${code}`)
      .digest('hex');
  }
  private challengeKey(subject: string): string {
    return `sensitive-action:challenge:${subject}`;
  }
  private codeKey(subject: string): string {
    return `sensitive-action:code:${subject}`;
  }
  private attemptsKey(subject: string): string {
    return `sensitive-action:attempts:${subject}`;
  }
  private authorizationKey(token: string): string {
    return `sensitive-action:authorization:${this.fingerprint(token)}`;
  }
}
