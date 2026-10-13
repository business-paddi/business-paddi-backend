import { BadRequestException, Injectable } from '@nestjs/common';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../database/prisma.service';
import { ListAuditEventsDto } from '../audit/dto/list-audit-events.dto';
import { BusinessAccessService } from './business-access.service';

export class BusinessAuditQuery extends ListAuditEventsDto {
  @IsOptional() @IsString() @MaxLength(200) eventType?: string;
  @IsOptional() @IsString() @MaxLength(64) actorUserId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

@Injectable()
export class BusinessAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
  ) {}
  async list(userId: string, businessId: string, query: BusinessAuditQuery) {
    if (query.from && query.to && new Date(query.from) > new Date(query.to))
      throw new BadRequestException('from must be before to');
    return this.prisma.$transaction(
      async (db) => {
        await this.access.lock(userId, businessId, ['audit_logs:view'], db);
        const where = {
          businessId,
          ...(query.eventType ? { eventType: query.eventType } : {}),
          ...(query.actorUserId ? { userId: query.actorUserId } : {}),
          ...(query.from || query.to
            ? {
                createdAt: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
        };
        if (
          query.cursor &&
          !(await db.auditEvent.findFirst({
            where: { ...where, eventId: query.cursor },
            select: { eventId: true },
          }))
        )
          throw new BadRequestException('Invalid business audit cursor');
        const events = await db.auditEvent.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { eventId: 'desc' }],
          take: query.limit + 1,
          ...(query.cursor
            ? { cursor: { eventId: query.cursor }, skip: 1 }
            : {}),
          select: {
            eventId: true,
            businessId: true,
            userId: true,
            eventType: true,
            category: true,
            outcome: true,
            severity: true,
            changes: true,
            metadata: true,
            createdAt: true,
          },
        });
        const items = events.slice(0, query.limit);
        return {
          items,
          nextCursor:
            events.length > query.limit
              ? (items.at(-1)?.eventId ?? null)
              : null,
        };
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
}
