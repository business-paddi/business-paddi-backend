import { Injectable } from '@nestjs/common';
import type {
  PayrollBatch,
  PayrollRecipient,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TaskOperationService } from '../tasks/task-operation.service';
import { decodeCursor, encodeCursor } from '../tasks/task.utils';
import { PayrollAccessService } from './payroll-access.service';
import type { PayrollAccess } from './payroll-access.service';
import { PayrollSourceService } from './payroll-source.service';
import { calculate, date, fail } from './payroll-calculation';
import type {
  Calculation,
  Source,
  Blocker,
  Totals,
} from './payroll-calculation';
import {
  PayrollCandidateDto,
  PayrollListDto,
  PayrollRecipientsDto,
} from './payroll.dto';
export type BatchCalculation = {
  totals: Totals | null;
  blockers: Blocker[];
  calculationStatus: 'ready' | 'blocked';
  recipientCount: number;
  readyRecipientCount: number;
};
@Injectable()
export class PayrollReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly source: PayrollSourceService,
    private readonly cursors: TaskOperationService,
  ) {}
  async find(
    businessId: string,
    batchId: string,
    db: Prisma.TransactionClient = this.prisma,
    lock = false,
  ) {
    if (lock)
      await db.$queryRaw`SELECT "id" FROM "PayrollBatch" WHERE "businessId"=${businessId} AND "id"=${batchId} FOR UPDATE`;
    const b = await db.payrollBatch.findUnique({
      where: { businessId_id: { businessId, id: batchId } },
    });
    if (!b) fail('PAYROLL_NOT_FOUND', 404);
    return b;
  }
  async batch(
    b: PayrollBatch,
    a: PayrollAccess,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const c = b.calculation as unknown as BatchCalculation;
    const editable = ['draft', 'changes_requested'].includes(b.status);
    const independent = !b.contributorUserIds.includes(a.actor.userId);
    const canReview =
      a.permissions.includes('payments:approve') &&
      independent &&
      b.status === 'submitted';
    const canPrepare = a.permissions.includes('payments:create') && editable;
    const sourceBlockers: Blocker[] = [];
    if (editable || b.status === 'submitted') {
      const recipients = await db.payrollRecipient.findMany({
        where: { batchId: b.id, removed: false },
      });
      const sources = await this.source.many(
        b.businessId,
        recipients.map((r) => r.employeeId),
        db,
      );
      for (const r of recipients) {
        const current = sources.get(r.employeeId);
        if (current?.version !== r.sourceVersion)
          sourceBlockers.push({
            code: 'SOURCE_CHANGED',
            message: 'Refresh this recipient before submission or approval',
            employeeId: r.employeeId,
            recipientId: r.id,
            field: null,
          });
      }
    }
    const approvers =
      canPrepare && c.calculationStatus === 'ready'
        ? await this.access.reviewers(
            b.businessId,
            [...b.contributorUserIds, a.actor.userId],
            db,
          )
        : [];
    return {
      id: b.id,
      businessId: b.businessId,
      name: b.name,
      status: b.status,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      payDate: b.payDate,
      payFrequency: b.payFrequency,
      currency: b.currency,
      notes: b.notes,
      revision: b.revision,
      ...c,
      blockers: [...c.blockers, ...sourceBlockers],
      sourceChanged: sourceBlockers.length > 0,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      submittedAt: b.submittedAt,
      approvedAt: b.approvedAt,
      cancelledAt: b.cancelledAt,
      createdBy: b.createdBy,
      submittedBy: b.submittedBy,
      reviewedBy: b.reviewedBy,
      reviewNote: b.reviewNote,
      cancellationReason: b.cancellationReason,
      calculationVersion: b.calculationVersion,
      capabilities: {
        canEdit: canPrepare,
        canRefresh: canPrepare,
        canSubmit:
          canPrepare &&
          c.calculationStatus === 'ready' &&
          approvers.length > 0 &&
          !sourceBlockers.length,
        canApprove: canReview && !sourceBlockers.length,
        canRequestChanges: canReview,
        canCancel:
          a.permissions.includes('payments:cancel') &&
          !['approved', 'cancelled'].includes(b.status),
      },
    };
  }
  async recipient(
    r: PayrollRecipient,
    db: Prisma.TransactionClient = this.prisma,
    currentVersion?: string,
  ) {
    const s = r.source as unknown as Source;
    const version =
      currentVersion ??
      (await this.source.read(r.businessId, r.employeeId, db)).version;
    const { employmentEndDate: _end, ...employee } = s.employee;
    void _end;
    return {
      id: r.id,
      batchId: r.batchId,
      employeeId: r.employeeId,
      employee,
      bank: this.source.bank(s),
      compensation: s.compensation,
      baseAmount: r.baseAmount ?? s.compensation.amount,
      baseOverrideReason: r.baseOverrideReason,
      adjustments: r.adjustments,
      ...(r.calculation as unknown as Calculation),
      sourceVersion: r.sourceVersion,
      snapshottedAt: r.snapshottedAt,
      sourceChanged: version !== r.sourceVersion,
      notes: r.notes,
    };
  }
  async detail(userId: string, businessId: string, batchId: string) {
    const a = await this.access.context(userId, businessId);
    return { batch: await this.batch(await this.find(businessId, batchId), a) };
  }
  async list(userId: string, businessId: string, q: PayrollListDto) {
    const a = await this.access.context(userId, businessId);
    if (q.periodFrom) date(q.periodFrom);
    if (q.periodTo) date(q.periodTo);
    if (q.periodFrom && q.periodTo && q.periodFrom > q.periodTo)
      fail('INVALID_PERIOD');
    const filter = {
      userId,
      businessId,
      route: 'batches',
      status: q.status ?? null,
      from: q.periodFrom ?? null,
      to: q.periodTo ?? null,
    };
    const cursor = decodeCursor<{ id: string; createdAt: string }>(
      this.cursors.secret,
      filter,
      q.cursor,
    );
    const where: Prisma.PayrollBatchWhereInput = {
      businessId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.periodFrom ? { periodEnd: { gte: q.periodFrom } } : {}),
      ...(q.periodTo ? { periodStart: { lte: q.periodTo } } : {}),
    };
    const [rows, counts] = await Promise.all([
      this.prisma.payrollBatch.findMany({
        where: {
          ...where,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: new Date(cursor.createdAt) } },
                  {
                    createdAt: new Date(cursor.createdAt),
                    id: { lt: cursor.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      }),
      this.prisma.payrollBatch.groupBy({ by: ['status'], where, _count: true }),
    ]);
    const selected = rows.slice(0, q.limit),
      last = selected.at(-1);
    const count = (status: string) =>
      counts.find((c) => c.status === status)?._count ?? 0;
    return {
      items: await Promise.all(selected.map((b) => this.batch(b, a))),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor(this.cursors.secret, filter, {
              id: last.id,
              createdAt: last.createdAt.toISOString(),
            })
          : null,
      summary: {
        draftCount: count('draft'),
        submittedCount: count('submitted'),
        changesRequestedCount: count('changes_requested'),
        approvedCount: count('approved'),
      },
    };
  }
  async recipients(
    userId: string,
    businessId: string,
    batchId: string,
    q: PayrollRecipientsDto,
  ) {
    await this.access.context(userId, businessId);
    await this.find(businessId, batchId);
    const filter = {
      userId,
      businessId,
      batchId,
      route: 'recipients',
      q: q.q ?? null,
      readiness: q.readiness ?? null,
    };
    const cursor = decodeCursor<{ id: string }>(
      this.cursors.secret,
      filter,
      q.cursor,
    );
    const rows = await this.prisma.payrollRecipient.findMany({
      where: {
        businessId,
        batchId,
        removed: false,
        ...(cursor ? { id: { gt: cursor.id } } : {}),
        ...(q.readiness
          ? { calculation: { path: ['readiness'], equals: q.readiness } }
          : {}),
        ...(q.q
          ? {
              source: {
                path: ['employee', 'fullName'],
                string_contains: q.q,
                mode: 'insensitive' as const,
              },
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: q.limit + 1,
    });
    const sources = await this.source.many(
      businessId,
      rows.slice(0, q.limit).map((r) => r.employeeId),
    );
    return {
      items: await Promise.all(
        rows
          .slice(0, q.limit)
          .map((r) =>
            this.recipient(r, this.prisma, sources.get(r.employeeId)?.version),
          ),
      ),
      nextCursor:
        rows.length > q.limit
          ? encodeCursor(this.cursors.secret, filter, {
              id: rows[q.limit - 1].id,
            })
          : null,
    };
  }
  async candidates(userId: string, businessId: string, q: PayrollCandidateDto) {
    await this.access.context(userId, businessId, ['payments:create']);
    if (!!q.periodStart !== !!q.periodEnd) fail('PERIOD_PAIR_REQUIRED');
    const start = q.periodStart
      ? date(q.periodStart)
      : new Date(Date.now() + 3600000).toISOString().slice(0, 7) + '-01';
    const end = q.periodEnd
      ? date(q.periodEnd)
      : new Date(
          Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0),
        )
          .toISOString()
          .slice(0, 10);
    if (start > end) fail('INVALID_PERIOD');
    const filter = {
      userId,
      businessId,
      route: 'candidates',
      q: q.q ?? null,
      type: q.employeeTypeId ?? null,
      group: q.groupId ?? null,
      frequency: q.payFrequency ?? null,
      start,
      end,
    };
    const cursor = decodeCursor<{ id: string }>(
      this.cursors.secret,
      filter,
      q.cursor,
    );
    const rows = await this.prisma.businessEmployee.findMany({
      where: {
        businessId,
        status: 'active',
        ...(cursor ? { id: { gt: cursor.id } } : {}),
        ...(q.q ? { fullName: { contains: q.q, mode: 'insensitive' } } : {}),
        ...(q.employeeTypeId ? { employeeTypeId: q.employeeTypeId } : {}),
        ...(q.groupId ? { groups: { some: { groupId: q.groupId } } } : {}),
        ...(q.payFrequency
          ? {
              payFrequency:
                q.payFrequency === 'bi-weekly'
                  ? 'bi_weekly'
                  : (q.payFrequency as 'monthly' | 'weekly' | 'one_time'),
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: q.limit + 1,
    });
    const sources = await this.source.many(
      businessId,
      rows.slice(0, q.limit).map((r) => r.id),
    );
    const items = rows.slice(0, q.limit).map((e) => {
      const { source: s, groups } = sources.get(e.id)!;
      const c = calculate(
        s,
        {
          periodStart: start,
          periodEnd: end,
          payFrequency: q.payFrequency ?? s.compensation.payFrequency,
        },
        null,
        [],
        e.id,
        null,
      );
      return {
        employeeId: e.id,
        fullName: e.fullName,
        avatar: s.employee.avatar,
        businessMemberId: e.businessMemberId,
        status: e.status,
        employmentStartDate: s.employee.employmentStartDate,
        employeeType: s.employee.employeeTypeName
          ? { id: e.employeeTypeId, name: s.employee.employeeTypeName }
          : null,
        groups,
        compensation: s.compensation,
        bankDetailsConfigured: !!(
          s.bank.bankCode &&
          s.bank.bankName &&
          s.bank.accountName &&
          s.bank.accountNumber
        ),
        accountVerificationStatus: s.bank.verificationStatus,
        readiness: c.readiness,
        blockers: c.blockers,
        warnings: c.warnings,
      };
    });
    return {
      items,
      nextCursor:
        rows.length > q.limit
          ? encodeCursor(this.cursors.secret, filter, {
              id: rows[q.limit - 1].id,
            })
          : null,
    };
  }
}
