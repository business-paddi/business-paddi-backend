import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { BusinessEmployee, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from './business-access.service';
import { EMPLOYEE_INCLUDE, employeeResponse } from './business.responses';

export type EmployeeLifecycleAction =
  'schedule' | 'cancel' | 'delete' | 'restore';
type LifecycleRecord = Pick<
  BusinessEmployee,
  | 'status'
  | 'deletionScheduledAt'
  | 'deletionRequestedAt'
  | 'deletionRequestedByUserId'
  | 'statusBeforeDeletion'
  | 'deletedAt'
>;
const previousStatuses = [
  'active',
  'suspended',
  'on_leave',
  'archived',
] as const;
const clearDeletion = {
  deletionScheduledAt: null,
  deletionRequestedAt: null,
  deletionRequestedByUserId: null,
  statusBeforeDeletion: null,
  deletedAt: null,
};
const eventNames = {
  schedule: 'deletion_scheduled',
  cancel: 'deletion_cancelled',
  delete: 'deleted',
  restore: 'restored',
} as const;

// Kept pure so boundary dates and illegal transitions can be exercised without a database.
export function planEmployeeLifecycle(
  current: LifecycleRecord,
  action: EmployeeLifecycleAction,
  now: Date,
  userId: string | null,
  scheduledFor?: Date,
): Prisma.BusinessEmployeeUncheckedUpdateInput | null {
  if (action === 'schedule') {
    if (
      !scheduledFor ||
      !Number.isFinite(scheduledFor.getTime()) ||
      scheduledFor <= now
    )
      throw new BadRequestException(
        'Deletion must be scheduled for a future timestamp with a timezone.',
      );
    if (current.status === 'deleted')
      throw new ConflictException(
        'Restore the deleted employee before scheduling deletion.',
      );
    if (current.status === 'scheduled_for_deletion') {
      if (current.deletionScheduledAt?.getTime() === scheduledFor.getTime())
        return null;
      throw new ConflictException(
        'Cancel the existing deletion schedule before changing it.',
      );
    }
    return {
      status: 'scheduled_for_deletion',
      deletionScheduledAt: scheduledFor,
      deletionRequestedAt: now,
      deletionRequestedByUserId: userId,
      statusBeforeDeletion: current.status,
      deletedAt: null,
      paymentStatus: 'blocked',
      paymentBlockedReason: 'employee_scheduled_for_deletion',
    };
  }
  if (action === 'cancel') {
    if (current.status !== 'scheduled_for_deletion')
      throw new ConflictException('Employee has no pending deletion.');
    if (!current.deletionScheduledAt || current.deletionScheduledAt <= now)
      throw new ConflictException(
        'The deletion time has been reached. Restore the employee after deletion completes.',
      );
    const status =
      previousStatuses.find((item) => item === current.statusBeforeDeletion) ??
      'archived';
    return {
      ...clearDeletion,
      status,
      paymentStatus: 'blocked',
      paymentBlockedReason:
        status === 'archived'
          ? 'employee_archived'
          : 'payment_setup_requires_verification',
    };
  }
  if (action === 'delete') {
    if (current.status === 'deleted') return null;
    return {
      status: 'deleted',
      deletionScheduledAt: null,
      deletionRequestedAt: current.deletionRequestedAt ?? now,
      deletionRequestedByUserId: current.deletionRequestedByUserId ?? userId,
      statusBeforeDeletion: current.statusBeforeDeletion ?? current.status,
      deletedAt: now,
      paymentStatus: 'blocked',
      paymentBlockedReason: 'employee_deleted',
    };
  }
  if (current.status === 'archived' && !current.deletedAt) return null;
  if (current.status !== 'deleted')
    throw new ConflictException('Only deleted employees can be restored.');
  return {
    ...clearDeletion,
    status: 'archived',
    paymentStatus: 'blocked',
    paymentBlockedReason: 'employee_archived',
  };
}

@Injectable()
export class EmployeeLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
  ) {}

  private async apply(
    db: Prisma.TransactionClient,
    businessId: string,
    employeeId: string,
    action: EmployeeLifecycleAction,
    userId: string | null,
    now: Date,
    scheduledFor?: Date,
    reason?: string,
  ) {
    const current = await db.businessEmployee.findUnique({
      where: { businessId_id: { businessId, id: employeeId } },
      include: EMPLOYEE_INCLUDE,
    });
    if (!current) throw new NotFoundException('Employee not found');
    const data = planEmployeeLifecycle(
      current,
      action,
      now,
      userId,
      scheduledFor,
    );
    if (!data) return { employee: employeeResponse(current), changed: false };
    const employee = await db.businessEmployee.update({
      where: { businessId_id: { businessId, id: employeeId } },
      data,
      include: EMPLOYEE_INCLUDE,
    });
    await db.auditEvent.create({
      data: {
        eventId: randomUUID(),
        businessId,
        userId,
        eventType: `business.employee.${eventNames[action]}`,
        category: 'business',
        outcome: 'success',
        reason,
        metadata: {
          employeeId,
          requestedByUserId: employee.deletionRequestedByUserId,
          scheduledFor:
            scheduledFor?.toISOString() ??
            current.deletionScheduledAt?.toISOString() ??
            null,
        },
        changes: {
          status: { before: current.status, after: employee.status },
          deletionScheduledAt: {
            before: current.deletionScheduledAt?.toISOString() ?? null,
            after: employee.deletionScheduledAt?.toISOString() ?? null,
          },
          deletedAt: {
            before: current.deletedAt?.toISOString() ?? null,
            after: employee.deletedAt?.toISOString() ?? null,
          },
        },
      },
    });
    return { employee: employeeResponse(employee), changed: true };
  }

  async mutate(
    userId: string,
    businessId: string,
    employeeId: string,
    action: EmployeeLifecycleAction,
    scheduledFor?: string,
    reason?: string,
  ) {
    return this.prisma.$transaction(
      async (db) => {
        // No new permission grants: this is a recoverable employee archival operation.
        await this.access.lock(
          userId,
          businessId,
          action === 'restore'
            ? ['employees:archive', 'employees:update']
            : ['employees:archive'],
          db,
        );
        await db.$queryRaw`SELECT "id" FROM "BusinessEmployee" WHERE "businessId" = ${businessId} AND "id" = ${employeeId} FOR UPDATE`;
        return this.apply(
          db,
          businessId,
          employeeId,
          action,
          userId,
          new Date(),
          scheduledFor ? new Date(scheduledFor) : undefined,
          reason,
        );
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }

  async processDue(now = new Date(), businessId?: string) {
    return this.prisma.$transaction(
      async (db) => {
        const due = await db.$queryRaw<
          Array<{ id: string; businessId: string }>
        >`SELECT "id", "businessId" FROM "BusinessEmployee" WHERE "status" = 'scheduled_for_deletion' AND "deletionScheduledAt" <= ${now} AND (${businessId ?? null}::text IS NULL OR "businessId" = ${businessId ?? null}) ORDER BY "deletionScheduledAt", "id" LIMIT 20 FOR UPDATE SKIP LOCKED`;
        if (!due.length) return 0;
        await db.$queryRaw`SELECT set_config('business_paddi.actor_id', '', true)`;
        for (const employee of due)
          await this.apply(
            db,
            employee.businessId,
            employee.id,
            'delete',
            null,
            now,
            undefined,
            'Scheduled employee deletion',
          );
        return due.length;
      },
      { maxWait: 15000, timeout: 60000 },
    );
  }
}
