import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type PayrollBatch,
  type PayrollRecipient,
} from '../../generated/prisma/client';
import type { Permission } from '../business-foundation/permission-catalog';
import { PrismaService } from '../database/prisma.service';
import { digest } from '../tasks/task.utils';
import { PayrollAccessService } from './payroll-access.service';
import { PayrollSourceService } from './payroll-source.service';
import { PayrollReadService } from './payroll-read.service';
import type { BatchCalculation } from './payroll-read.service';
import { PayrollEventsService, storedJson } from './payroll-events.service';
import {
  calculate,
  cents,
  date,
  fail,
  money,
  POLICY,
  sumTotals,
} from './payroll-calculation';
import type {
  Adjustment,
  Calculation,
  Source,
  Totals,
} from './payroll-calculation';
import {
  PayrollCreateDto,
  PayrollPatchDto,
  PayrollRecipientPatchDto,
  PayrollRefreshDto,
  PayrollSubmitDto,
  PayrollReviewDto,
  PayrollCancelDto,
} from './payroll.dto';
type Mutation =
  | PayrollPatchDto
  | PayrollRecipientPatchDto
  | PayrollRefreshDto
  | PayrollSubmitDto
  | PayrollReviewDto
  | PayrollCancelDto;
const editable = (b: PayrollBatch) =>
  ['draft', 'changes_requested'].includes(b.status);
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly source: PayrollSourceService,
    private readonly read: PayrollReadService,
    private readonly events: PayrollEventsService,
  ) {}
  private async run(
    userId: string,
    businessId: string,
    grants: Permission[],
    key: string | undefined,
    request: unknown,
    work: (
      db: Prisma.TransactionClient,
      a: Awaited<ReturnType<PayrollAccessService['context']>>,
    ) => Promise<unknown>,
  ) {
    if (key !== undefined && !/^[\x21-\x7e]{1,100}$/.test(key))
      fail('INVALID_IDEMPOTENCY_KEY');
    return this.prisma.$transaction(
      async (db) => {
        const a = await this.access.context(
          userId,
          businessId,
          grants,
          db,
          true,
        );
        // Shared ordering for every payroll mutation also serializes conflict inspection.
        await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:${businessId}`},0))::text`;
        if (key) {
          const previous = await db.payrollOperation.findUnique({
            where: { businessId_userId_key: { businessId, userId, key } },
          });
          if (previous) {
            if (previous.hash !== digest(request))
              fail('IDEMPOTENCY_CONFLICT', 409);
            return previous.result;
          }
        }
        const response = storedJson(await work(db, a));
        if (key)
          await db.payrollOperation.create({
            data: {
              businessId,
              userId,
              key,
              hash: digest(request),
              result: response,
            },
          });
        return response;
      },
      { maxWait: 15000, timeout: 120000 },
    );
  }
  private async add(
    db: Prisma.TransactionClient,
    b: PayrollBatch,
    employeeIds: string[],
  ) {
    const sources = await this.source.many(b.businessId, employeeIds, db, true);
    for (const employeeId of [...employeeIds].sort()) {
      const previous = await db.payrollRecipient.findUnique({
        where: { batchId_employeeId: { batchId: b.id, employeeId } },
      });
      if (previous && !previous.removed) fail('DUPLICATE_RECIPIENT', 409);
      const data = sources.get(employeeId);
      if (!data) fail('EMPLOYEE_NOT_FOUND', 404);
      const recipientId = previous?.id ?? randomUUID();
      const calculation = calculate(
        data.source,
        b,
        null,
        [],
        employeeId,
        recipientId,
      );
      const payload = {
        source: storedJson(data.source),
        sourceVersion: data.version,
        snapshottedAt: new Date(),
        baseAmount: null,
        baseOverrideReason: null,
        adjustments: [],
        notes: null,
        removed: false,
        calculation: storedJson(calculation),
      };
      if (previous)
        await db.payrollRecipient.update({
          where: { id: previous.id },
          data: payload,
        });
      else
        await db.payrollRecipient.create({
          data: {
            ...payload,
            id: recipientId,
            businessId: b.businessId,
            batchId: b.id,
            employeeId,
          },
        });
    }
  }
  private async totals(
    db: Prisma.TransactionClient,
    batchId: string,
  ): Promise<BatchCalculation> {
    const rows = await db.payrollRecipient.findMany({
      where: { batchId, removed: false },
    });
    if (rows.length > 250) fail('RECIPIENT_LIMIT_EXCEEDED');
    return this.rollup(
      rows.map((r) => r.calculation as unknown as Calculation),
    );
  }
  private rollup(calculations: Calculation[]): BatchCalculation {
    const blockers = calculations.flatMap((c) => c.blockers);
    if (!calculations.length)
      blockers.push({
        code: 'RECIPIENTS_REQUIRED',
        message: 'At least one recipient is required',
        employeeId: null,
        recipientId: null,
        field: 'employeeIds',
      });
    return {
      totals: blockers.length
        ? null
        : sumTotals(calculations.map((c) => c.totals as Totals)),
      blockers,
      calculationStatus: blockers.length ? 'blocked' : 'ready',
      recipientCount: calculations.length,
      readyRecipientCount: calculations.filter((c) => c.readiness === 'ready')
        .length,
    };
  }
  async create(
    userId: string,
    businessId: string,
    body: PayrollCreateDto,
    key?: string,
  ) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    date(body.periodStart);
    date(body.periodEnd);
    date(body.payDate);
    if (body.periodStart > body.periodEnd || body.payDate < body.periodEnd)
      fail('INVALID_PERIOD');
    return this.run(
      userId,
      businessId,
      ['payments:create'],
      key,
      { route: 'create', body },
      async (db, a) => {
        const prepared = [] as {
          id: string;
          employeeId: string;
          source: Source;
          sourceVersion: string;
          calculation: Calculation;
        }[];
        const sources = await this.source.many(
          businessId,
          body.employeeIds,
          db,
          true,
        );
        for (const employeeId of [...body.employeeIds].sort()) {
          const current = sources.get(employeeId),
            id = randomUUID();
          if (!current) fail('EMPLOYEE_NOT_FOUND', 404);
          prepared.push({
            id,
            employeeId,
            source: current.source,
            sourceVersion: current.version,
            calculation: calculate(
              current.source,
              body,
              null,
              [],
              employeeId,
              id,
            ),
          });
        }
        const ready = await db.payrollBatch.create({
          data: {
            businessId,
            name: body.name,
            periodStart: body.periodStart,
            periodEnd: body.periodEnd,
            payDate: body.payDate,
            payFrequency: body.payFrequency,
            currency: body.currency,
            notes: body.notes,
            createdBy: a.actor,
            contributorUserIds: [userId],
            calculation: storedJson(
              this.rollup(prepared.map((r) => r.calculation)),
            ),
            calculationVersion: POLICY,
          },
        });
        await db.payrollRecipient.createMany({
          data: prepared.map((r) => ({
            ...r,
            source: storedJson(r.source),
            calculation: storedJson(r.calculation),
            businessId,
            batchId: ready.id,
          })),
        });
        await this.events.record(db, ready, a.actor, 'created', [
          'metadata',
          'recipients',
        ]);
        return { batch: await this.read.batch(ready, a, db) };
      },
    );
  }
  private revision(b: PayrollBatch, expected: number) {
    if (b.revision !== expected)
      fail('REVISION_CONFLICT', 409, { currentRevision: b.revision });
  }
  private async recipient(
    db: Prisma.TransactionClient,
    b: PayrollBatch,
    id: string,
  ) {
    const r = await db.payrollRecipient.findFirst({
      where: { id, batchId: b.id, businessId: b.businessId, removed: false },
    });
    if (!r) fail('PAYROLL_RECIPIENT_NOT_FOUND', 404);
    return r;
  }
  private async fresh(db: Prisma.TransactionClient, b: PayrollBatch) {
    const rows = await db.payrollRecipient.findMany({
      where: { batchId: b.id, removed: false },
      orderBy: { employeeId: 'asc' },
    });
    const blockers = [] as {
      code: string;
      employeeId: string;
      recipientId: string;
    }[];
    const sources = await this.source.many(
      b.businessId,
      rows.map((r) => r.employeeId),
      db,
      true,
    );
    for (const r of rows) {
      const current = sources.get(r.employeeId);
      if (current?.version !== r.sourceVersion)
        blockers.push({
          code: 'SOURCE_CHANGED',
          employeeId: r.employeeId,
          recipientId: r.id,
        });
    }
    if (blockers.length) fail('SOURCE_CHANGED', 409, { blockers });
    // Annualised regular-monthly PAYE cannot reconcile a changing annual pattern.
    // Approved preparation records are not treated as actual tax remittances.
    const previous = await db.payrollRecipient.findMany({
      where: {
        businessId: b.businessId,
        employeeId: { in: rows.map((r) => r.employeeId) },
        removed: false,
        batch: {
          status: 'approved',
          periodStart: {
            gte: `${b.periodStart.slice(0, 4)}-01-01`,
            lt: b.periodStart,
          },
        },
      },
      select: { employeeId: true, calculation: true },
    });
    const projection = (value: Prisma.JsonValue) => {
      const c = value as unknown as Calculation;
      return digest({
        gross: c.totals?.grossAmount,
        statutoryLines: c.statutoryLines,
      });
    };
    const incompatible = rows.filter((r) =>
      previous.some(
        (p) =>
          p.employeeId === r.employeeId &&
          projection(p.calculation) !== projection(r.calculation),
      ),
    );
    if (incompatible.length)
      fail('YTD_RECONCILIATION_REQUIRED', 422, {
        blockers: incompatible.map((r) => ({
          code: 'YTD_RECONCILIATION_REQUIRED',
          message:
            'Changed regular earnings or statutory inputs need a cumulative policy',
          employeeId: r.employeeId,
          recipientId: r.id,
          field: null,
        })),
      });
  }
  private async conflicts(db: Prisma.TransactionClient, b: PayrollBatch) {
    const recipients = await db.payrollRecipient.findMany({
      where: { batchId: b.id, removed: false },
      select: { employeeId: true },
    });
    const conflicts = await db.payrollObligation.findMany({
      where: {
        businessId: b.businessId,
        batchId: { not: b.id },
        employeeId: { in: recipients.map((r) => r.employeeId) },
        periodStart: { lte: new Date(b.periodEnd) },
        periodEnd: { gte: new Date(b.periodStart) },
      },
      select: { batchId: true, employeeId: true },
    });
    if (conflicts.length)
      fail('DUPLICATE_PAYROLL', 409, {
        conflictingBatchIds: [...new Set(conflicts.map((c) => c.batchId))],
        blockers: conflicts.map((c) => ({
          code: 'DUPLICATE_PAYROLL',
          employeeId: c.employeeId,
          conflictingBatchId: c.batchId,
        })),
      });
  }
  async mutate(
    userId: string,
    businessId: string,
    batchId: string,
    route: 'patch' | 'recipient' | 'refresh' | 'submit' | 'review' | 'cancel',
    body: Mutation,
    key?: string,
    recipientId?: string,
  ) {
    if (['refresh', 'submit', 'review', 'cancel'].includes(route) && !key)
      fail('IDEMPOTENCY_KEY_REQUIRED');
    const grant =
      route === 'review'
        ? 'payments:approve'
        : route === 'cancel'
          ? 'payments:cancel'
          : 'payments:create';
    return this.run(
      userId,
      businessId,
      [grant],
      key,
      { batchId, route, recipientId, body },
      async (db, a) => {
        let b = await this.read.find(businessId, batchId, db, true);
        this.revision(b, body.expectedRevision);
        const data: Prisma.PayrollBatchUpdateInput = {
          revision: { increment: 1 },
        };
        let event: string =
          route === 'patch' || route === 'recipient'
            ? 'updated'
            : route === 'refresh'
              ? 'refreshed'
              : route;
        let note: string | undefined;
        const changes: { recipientId: string; changedFields: string[] }[] = [];
        const changedFields: string[] = [];
        if (['patch', 'recipient', 'refresh'].includes(route)) {
          if (!editable(b)) fail('INVALID_TRANSITION', 409);
          data.contributorUserIds = [
            ...new Set([...b.contributorUserIds, userId]),
          ];
          if (route === 'patch') {
            const input = body as PayrollPatchDto;
            if (input.name !== undefined) {
              data.name = input.name;
              changedFields.push('name');
            }
            if (input.notes !== undefined) {
              data.notes = input.notes;
              changedFields.push('notes');
            }
            if (input.payDate !== undefined) {
              date(input.payDate);
              if (input.payDate < b.periodEnd) fail('INVALID_PAY_DATE');
              data.payDate = input.payDate;
              changedFields.push('payDate');
            }
            if (input.removeRecipientIds)
              for (const id of input.removeRecipientIds) {
                await this.recipient(db, b, id);
                await db.payrollRecipient.update({
                  where: { id },
                  data: { removed: true },
                });
              }
            if (input.addEmployeeIds?.length)
              await this.add(db, b, input.addEmployeeIds);
            if (
              input.removeRecipientIds?.length ||
              input.addEmployeeIds?.length
            )
              changedFields.push('recipients');
            if (input.payDate !== undefined) {
              const recipients = await db.payrollRecipient.findMany({
                where: { batchId: b.id, removed: false },
              });
              for (const r of recipients)
                await db.payrollRecipient.update({
                  where: { id: r.id },
                  data: {
                    calculation: storedJson(
                      calculate(
                        r.source as unknown as Source,
                        { ...b, payDate: input.payDate },
                        r.baseAmount,
                        r.adjustments as unknown as Adjustment[],
                        r.employeeId,
                        r.id,
                      ),
                    ),
                  },
                });
            }
          } else if (route === 'recipient') {
            const input = body as PayrollRecipientPatchDto;
            const r = await this.recipient(db, b, recipientId!);
            const update: Prisma.PayrollRecipientUpdateInput = {};
            let adjustments = r.adjustments as unknown as Adjustment[];
            if (input.adjustments !== undefined) {
              const old = new Map(adjustments.map((x) => [x.clientId, x.id]));
              adjustments = input.adjustments.map((x) => ({
                ...x,
                id: old.get(x.clientId) ?? randomUUID(),
                amount: money(cents(x.amount)),
              }));
              update.adjustments = storedJson(adjustments);
              changedFields.push('adjustments');
            }
            let base = r.baseAmount;
            if (input.baseAmount !== undefined) {
              if (!input.baseOverrideReason?.trim())
                fail('BASE_OVERRIDE_REASON_REQUIRED');
              base = money(cents(input.baseAmount));
              update.baseAmount = base;
              update.baseOverrideReason = input.baseOverrideReason;
              changedFields.push('baseOverride');
            } else if (input.baseOverrideReason !== undefined) {
              if (r.baseAmount === null) fail('BASE_OVERRIDE_REQUIRED');
              update.baseOverrideReason = input.baseOverrideReason;
              changedFields.push('baseOverrideReason');
            }
            if (input.notes !== undefined) {
              update.notes = input.notes;
              changedFields.push('recipientNotes');
            }
            update.calculation = storedJson(
              calculate(
                r.source as unknown as Source,
                b,
                base,
                adjustments,
                r.employeeId,
                r.id,
              ),
            );
            await db.payrollRecipient.update({
              where: { id: r.id },
              data: update,
            });
          } else {
            const input = body as PayrollRefreshDto;
            const rows: PayrollRecipient[] = [];
            for (const id of input.recipientIds)
              rows.push(await this.recipient(db, b, id));
            rows.sort((x, y) => x.employeeId.localeCompare(y.employeeId));
            const sources = await this.source.many(
              businessId,
              rows.map((r) => r.employeeId),
              db,
              true,
            );
            for (const r of rows) {
              const current = sources.get(r.employeeId);
              if (!current) fail('EMPLOYEE_NOT_FOUND', 404);
              const before = r.source as unknown as Source;
              const fields = (
                ['employee', 'bank', 'compensation', 'tax'] as const
              ).filter((k) => digest(before[k]) !== digest(current.source[k]));
              await db.payrollRecipient.update({
                where: { id: r.id },
                data: {
                  source: storedJson(current.source),
                  sourceVersion: current.version,
                  snapshottedAt: new Date(),
                  calculation: storedJson(
                    calculate(
                      current.source,
                      b,
                      r.baseAmount,
                      r.adjustments as unknown as Adjustment[],
                      r.employeeId,
                      r.id,
                    ),
                  ),
                },
              });
              changes.push({ recipientId: r.id, changedFields: fields });
            }
            changedFields.push('snapshots');
          }
          data.calculation = storedJson(await this.totals(db, b.id));
          data.calculationVersion = POLICY;
        } else if (route === 'submit') {
          if (!editable(b)) fail('INVALID_TRANSITION', 409);
          await this.fresh(db, b);
          await this.conflicts(db, b);
          const c = b.calculation as unknown as BatchCalculation;
          if (c.calculationStatus !== 'ready' || !c.totals)
            fail('PAYROLL_NOT_READY', 422, { blockers: c.blockers });
          if (b.calculationVersion !== POLICY)
            fail('CALCULATION_VERSION_CHANGED', 409);
          const contributors = [...new Set([...b.contributorUserIds, userId])];
          if (
            !(await this.access.reviewers(businessId, contributors, db, true))
              .length
          )
            fail('INDEPENDENT_APPROVER_REQUIRED', 422);
          data.status = 'submitted';
          data.submittedBy = a.actor;
          data.submittedAt = new Date();
          data.contributorUserIds = contributors;
          data.reviewedBy = Prisma.JsonNull;
          data.reviewNote = null;
          event = 'submitted';
          note = (body as PayrollSubmitDto).note;
          changedFields.push('status');
        } else if (route === 'review') {
          if (b.status !== 'submitted') fail('INVALID_TRANSITION', 409);
          if (b.contributorUserIds.includes(userId))
            fail('INDEPENDENT_REVIEWER_REQUIRED', 403);
          const input = body as PayrollReviewDto;
          note = input.note;
          if (input.decision === 'request_changes' && !note?.trim())
            fail('REVIEW_REASON_REQUIRED');
          if (input.decision === 'approve') {
            await this.fresh(db, b);
            await this.conflicts(db, b);
            if (b.calculationVersion !== POLICY)
              fail('CALCULATION_VERSION_CHANGED', 409);
            const c = b.calculation as unknown as BatchCalculation;
            if (c.calculationStatus !== 'ready')
              fail('PAYROLL_NOT_READY', 422, { blockers: c.blockers });
            data.status = 'approved';
            data.approvedAt = new Date();
            event = 'approved';
          } else {
            data.status = 'changes_requested';
            event = 'changes_requested';
          }
          data.reviewedBy = a.actor;
          data.reviewNote = note ?? null;
          changedFields.push('status');
        } else {
          if (['approved', 'cancelled'].includes(b.status))
            fail('INVALID_TRANSITION', 409);
          const input = body as PayrollCancelDto;
          note = input.reason;
          data.status = 'cancelled';
          data.cancelledAt = new Date();
          data.cancellationReason = input.reason;
          event = 'cancelled';
          changedFields.push('status');
        }
        b = await db.payrollBatch.update({ where: { id: b.id }, data });
        await this.events.record(db, b, a.actor, event, changedFields, note);
        const batch = await this.read.batch(b, a, db);
        if (route === 'recipient')
          return {
            batch,
            recipient: await this.read.recipient(
              await this.recipient(db, b, recipientId!),
              db,
            ),
          };
        if (route === 'refresh') return { batch, changes };
        return { batch };
      },
    );
  }
}
