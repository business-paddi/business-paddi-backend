import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ReferralCursor } from './referral-cursor';

const META_KEYS = new Set([
  'plan',
  'mode',
  'reason',
  'currency',
  'amountMinor',
  'commissionMinor',
  'reversedMinor',
  'status',
]);
export async function recordReferralAudit(
  db: Prisma.TransactionClient,
  input: Omit<Prisma.ReferralAuditUncheckedCreateInput, 'metadata'> & {
    metadata?: Record<string, string | number | boolean | null>;
  },
) {
  const metadata = input.metadata ?? {};
  if (
    Object.keys(metadata).some((key) => !META_KEYS.has(key)) ||
    Object.values(metadata).some(
      (v) =>
        (typeof v === 'object' && v !== null) ||
        (typeof v === 'string' && v.length > 100),
    )
  )
    throw new Error('Invalid referral audit metadata');
  return db.referralAudit.create({ data: { ...input, metadata } });
}

@Injectable()
export class ReferralAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cursors: ReferralCursor,
  ) {}
  // Account scope is an explicit authorized caller ID. No global-admin query or HTTP endpoint exists.
  async queryForAccount(
    authorizedUserId: string,
    filters: {
      cursor?: string;
      from?: string;
      to?: string;
      event?: string;
    } = {},
  ) {
    const { from, to, event } = filters;
    for (const date of [from, to])
      if (
        date &&
        (!Number.isFinite(Date.parse(date)) ||
          !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(date))
      )
        throw new BadRequestException(
          'Audit dates must be UTC ISO timestamps.',
        );
    if (from && to && new Date(from) > new Date(to))
      throw new BadRequestException('Audit date range is reversed.');
    if (event && !/^referral\.[a-z_]{1,60}$/.test(event))
      throw new BadRequestException('Invalid referral audit event filter.');
    const scope = `audit:${authorizedUserId}:${JSON.stringify({ from, to, event })}`;
    const cursor = this.cursors.decode(scope, filters.cursor);
    const rows = await this.prisma.referralAudit.findMany({
      where: {
        subjectUserId: authorizedUserId,
        ...(event ? { eventType: event } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: { id: true, eventType: true, createdAt: true, metadata: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 26,
    });
    const more = rows.length > 25;
    if (more) rows.pop();
    return {
      items: rows,
      nextCursor: more
        ? this.cursors.encode(scope, rows[rows.length - 1])
        : null,
    };
  }
}
