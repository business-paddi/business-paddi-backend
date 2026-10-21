import { Injectable, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PayrollBatch, Prisma } from '../../generated/prisma/client';
import type { Actor } from './payroll-access.service';
import { PayrollAccessService } from './payroll-access.service';
export const storedJson = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
@Injectable()
export class PayrollEventsService {
  constructor(private readonly access: PayrollAccessService) {}
  async record(
    db: Prisma.TransactionClient,
    b: PayrollBatch,
    actor: Actor,
    event: string,
    changedFields: string[],
    note?: string,
  ) {
    const recipients = await db.payrollRecipient.findMany({
      where: { batchId: b.id },
      orderBy: { id: 'asc' },
    });
    const history = await db.payrollHistory.create({
      data: {
        batchId: b.id,
        revision: b.revision,
        event,
        actor,
        snapshot: storedJson({ batch: b, recipients }),
        note,
      },
    });
    await db.auditEvent.create({
      data: {
        eventId: randomUUID(),
        businessId: b.businessId,
        userId: actor.userId,
        eventType: `business.payroll.${event}`,
        category: 'business',
        outcome: 'success',
        metadata: {
          batchId: b.id,
          revision: b.revision,
          actorName: actor.name,
          changedFields,
        },
      },
    });
    let targets: string[] = [];
    if (event === 'submitted')
      targets = (
        await this.access.reviewers(b.businessId, b.contributorUserIds, db)
      ).map((m) => m.userId);
    else if (['approved', 'changes_requested', 'cancelled'].includes(event)) {
      const creator = b.createdBy as unknown as Actor;
      const m = await db.businessMember.findFirst({
        where: { businessId: b.businessId, userId: creator.userId },
      });
      if (m)
        try {
          await this.access.context(m.userId, b.businessId, [], db);
          targets = [m.userId];
        } catch (error) {
          if (
            !(error instanceof HttpException) ||
            ![401, 403, 404].includes(error.getStatus())
          )
            throw error;
          /* Loss of access suppresses financial workflow alerts. */
        }
    }
    if (targets.length)
      await db.userNotification.createMany({
        skipDuplicates: true,
        data: [...new Set(targets)].map((userId) => ({
          userId,
          businessId: b.businessId,
          type: `payroll_${event}`,
          title: `Payroll ${event.replaceAll('_', ' ')}`,
          message: 'A payroll preparation batch needs your attention.',
          actionUrl: `/business/${b.businessId}/money/batches/${b.id}`,
          data: { batchId: b.id, revision: b.revision },
          eventKey: `payroll:${history.id}:${userId}`,
        })),
      });
  }
}
