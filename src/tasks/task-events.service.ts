import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { BusinessTask, Prisma } from '../../generated/prisma/client';
import type { TaskIdentity } from './task-access.service';
@Injectable()
export class TaskEventsService {
  async record(
    db: Prisma.TransactionClient,
    t: BusinessTask,
    actor: TaskIdentity,
    event: string,
    options: {
      reason?: string;
      attemptId?: string;
      data?: Prisma.InputJsonValue;
      recipients?: string[];
      type?: string;
    } = {},
  ) {
    const entry = await db.taskEntry.create({
      data: {
        taskId: t.id,
        kind: 'history',
        event,
        actor,
        assignmentId: t.assignmentId,
        attemptId: options.attemptId,
        reason: options.reason,
        data: options.data ?? { status: t.status, revision: t.revision },
      },
    });
    await db.auditEvent.create({
      data: {
        eventId: randomUUID(),
        businessId: t.businessId,
        userId: actor.userId,
        eventType: `business.task.${event}`,
        category: 'business',
        outcome: 'success',
        metadata: {
          taskId: t.id,
          assignmentId: t.assignmentId,
          attemptId: options.attemptId ?? null,
          actorName: actor.name,
          status: t.status,
          revision: t.revision,
        },
      },
    });
    for (const memberId of new Set(options.recipients ?? [])) {
      const m = await db.businessMember.findFirst({
        where: {
          id: memberId,
          businessId: t.businessId,
          status: 'active',
          approvalStatus: { in: ['approved', 'not_required'] },
          role: { status: 'active' },
          user: { status: 'active', emailVerifiedAt: { not: null } },
        },
      });
      if (!m || m.userId === actor.userId) continue;
      await db.userNotification.create({
        data: {
          userId: m.userId,
          businessId: t.businessId,
          type: options.type ?? `task_${event}`,
          title: `Task ${event.replaceAll('_', ' ')}`,
          message: t.title,
          actionUrl: `/business/${t.businessId}/tasks/${t.id}`,
          data: { taskId: t.id },
          eventKey: `task:${entry.id}:${m.id}`,
        },
      });
    }
    return entry;
  }
}
