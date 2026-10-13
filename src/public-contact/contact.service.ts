import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { digest } from '../tasks/task.utils';
import type { ContactDto } from './contact.dto';
export class ContactRateLimitError extends HttpException {
  constructor(readonly retryAfter: number) {
    super(
      {
        code: 'CONTACT_RATE_LIMITED',
        message: 'Please try again later',
        retryAfter,
      },
      429,
    );
  }
}
@Injectable()
export class ContactService {
  private readonly secret: string;
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow('VERIFICATION_CODE_PEPPER');
  }
  private hash(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
  async receive(ip: string, b: ContactDto, key?: string) {
    if (key !== undefined && !/^[\x21-\x7e]{1,100}$/.test(key))
      throw new BadRequestException('Invalid Idempotency-Key');
    const fingerprint = this.hash(digest({ ...b, website: undefined }));
    const retryKey = key ? this.hash(`retry:${b.email}:${key}`) : null;
    try {
      const outcome = await this.prisma.$transaction(
        async (db) => {
          const now = Date.now();
          // Fixed windows in PostgreSQL are shared by all application instances. Lock order is stable.
          const policies = [
            { identity: `ip:${ip}`, window: 15 * 60000, max: 5 },
            { identity: `ip:${ip}`, window: 86400000, max: 20 },
            { identity: `email:${b.email}`, window: 3600000, max: 3 },
          ];
          const buckets = policies
            .map((p) => ({
              ...p,
              key: this.hash(
                `${p.identity}:${p.window}:${Math.floor(now / p.window)}`,
              ),
              expiresAt: new Date((Math.floor(now / p.window) + 1) * p.window),
            }))
            .sort((a, b) => a.key.localeCompare(b.key));
          await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`contact-retry:${retryKey ?? fingerprint}`},0))::text`;
          for (const bucket of buckets)
            await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`contact:${bucket.key}`},0))::text`;
          if (!b.website) {
            const previous = await db.contactRequest.findFirst({
              where: retryKey
                ? { retryKey, createdAt: { gte: new Date(now - 24 * 3600000) } }
                : {
                    fingerprint,
                    createdAt: { gte: new Date(now - 5 * 60000) },
                  },
              orderBy: { createdAt: 'desc' },
            });
            if (previous) {
              if (previous.fingerprint !== fingerprint)
                throw new ConflictException({
                  code: 'IDEMPOTENCY_CONFLICT',
                  message: 'Retry key was already used for another request',
                });
              return { requestId: previous.id, status: 'received' as const };
            }
          }
          let retryAfter = 0;
          for (const bucket of buckets) {
            const saved = await db.contactRateBucket.findUnique({
              where: { key: bucket.key },
            });
            if (saved && saved.count >= bucket.max)
              retryAfter = Math.max(
                retryAfter,
                Math.ceil((bucket.expiresAt.getTime() - now) / 1000),
              );
          }
          if (retryAfter) return { limited: retryAfter };
          for (const bucket of buckets)
            await db.contactRateBucket.upsert({
              where: { key: bucket.key },
              create: { key: bucket.key, expiresAt: bucket.expiresAt },
              update: { count: { increment: 1 } },
            });
          await db.contactRateBucket.deleteMany({
            where: { expiresAt: { lt: new Date(now - 86400000) } },
          });
          if (b.website) return { rejected: true };
          const row = await db.contactRequest.create({
            data: {
              kind: b.kind,
              name: b.name,
              email: b.email,
              businessName: b.businessName,
              locations: b.locations,
              planInterest: b.planInterest,
              focus: b.focus,
              message: b.message,
              fingerprint,
              retryKey,
            },
          });
          return { requestId: row.id, status: 'received' as const };
        },
        { maxWait: 15000, timeout: 30000 },
      );
      if ('limited' in outcome && outcome.limited)
        throw new ContactRateLimitError(outcome.limited);
      if ('rejected' in outcome)
        throw new BadRequestException({
          code: 'CONTACT_REQUEST_REJECTED',
          message: 'Unable to accept this request',
        });
      return outcome;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new ServiceUnavailableException({
        code: 'CONTACT_STORAGE_UNAVAILABLE',
        message: 'Unable to save request; please retry later',
      });
    }
  }
}
