import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { AuditValue, RecordAuditEventInput } from './audit-event.types';
import type { ListAuditEventsDto } from './dto/list-audit-events.dto';

type AuditDatabase = Pick<Prisma.TransactionClient, 'auditEvent'>;

@Injectable()
export class AuditService {
  private static readonly MAX_VALUE_LENGTH = 500;
  private static readonly SENSITIVE_KEY =
    /(password|passcode|secret|token|cookie|authorization|code|challenge)/i;

  private readonly logger = new Logger(AuditService.name);
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.pepper =
      configService.get<string>('AUDIT_LOG_PEPPER') ??
      configService.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
  }

  async record(
    input: RecordAuditEventInput,
    database: AuditDatabase = this.prisma,
  ): Promise<void> {
    const metadata = this.sanitizeMap(input.metadata);
    const changes = this.sanitizeMap(input.changes);
    const request = input.context?.requestMetadata;
    const location = input.context?.location;

    await database.auditEvent.create({
      data: {
        eventId: randomUUID(),
        eventType: input.eventType,
        category: input.category,
        outcome: input.outcome,
        severity: input.severity ?? 'info',
        userId: input.userId ?? null,
        emailHash: input.email ? this.hashEmail(input.email) : null,
        userSessionId: input.userSessionId ?? null,
        authSessionId: input.authSessionId ?? null,
        requestId: request?.requestId ?? null,
        ipAddress: request?.ipAddress ?? null,
        userAgent: request?.userAgent ?? null,
        city: location?.city ?? null,
        region: location?.region ?? null,
        country: location?.country ?? null,
        reason: input.reason ? this.sanitizeString(input.reason) : null,
        changes,
        metadata,
      },
    });
  }

  async recordBestEffort(input: RecordAuditEventInput): Promise<void> {
    try {
      await this.record(input);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        `Could not persist audit event ${input.eventType}: ${detail}`,
      );
    }
  }

  hashEmail(email: string): string {
    return createHmac('sha256', this.pepper)
      .update(email.trim().toLowerCase())
      .digest('hex');
  }

  async listUserEvents(userId: string, query: ListAuditEventsDto) {
    if (query.cursor) {
      const cursor = await this.prisma.auditEvent.findFirst({
        where: { eventId: query.cursor, userId },
        select: { eventId: true },
      });
      if (!cursor) {
        throw new BadRequestException('Invalid audit cursor');
      }
    }

    const events = await this.prisma.auditEvent.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { eventId: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { eventId: query.cursor }, skip: 1 } : {}),
      select: {
        eventId: true,
        eventType: true,
        category: true,
        outcome: true,
        severity: true,
        userSessionId: true,
        authSessionId: true,
        requestId: true,
        ipAddress: true,
        userAgent: true,
        deviceName: true,
        city: true,
        region: true,
        country: true,
        reason: true,
        changes: true,
        metadata: true,
        createdAt: true,
      },
    });
    const hasMore = events.length > query.limit;
    const items = hasMore ? events.slice(0, query.limit) : events;
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.eventId ?? null) : null,
    };
  }

  private sanitizeMap(
    values: Record<string, AuditValue> | undefined,
  ): Prisma.InputJsonObject | undefined {
    if (!values) {
      return undefined;
    }

    const sanitized: Record<string, AuditValue> = {};
    for (const [key, value] of Object.entries(values)) {
      if (AuditService.SENSITIVE_KEY.test(key)) {
        throw new Error(`Sensitive audit field is not allowed: ${key}`);
      }

      sanitized[this.sanitizeString(key)] =
        typeof value === 'string' ? this.sanitizeString(value) : value;
    }

    return sanitized;
  }

  private sanitizeString(value: string): string {
    return value
      .replace(/[\r\n\u2028\u2029]/g, ' ')
      .slice(0, AuditService.MAX_VALUE_LENGTH);
  }
}
