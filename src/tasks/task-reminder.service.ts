import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TaskAccessService } from './task-access.service';
import type { TaskIdentity } from './task-access.service';
import { OPEN_STATUSES } from './task.utils';
@Injectable()
export class TaskReminderService
  implements OnModuleInit, OnApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(TaskReminderService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TaskAccessService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.reconcile().catch(() =>
          this.logger.warn('Task reminder reconciliation failed; will retry'),
        ),
      60000,
    );
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
  async reconcile() {
    if (this.running) return;
    this.running = true;
    try {
      let after: string | undefined;
      for (;;) {
        const rows = await this.prisma.businessTask.findMany({
          where: {
            status: { in: OPEN_STATUSES },
            dueAt: { lte: new Date(Date.now() + 24 * 3600000) },
            assigneeMemberId: { not: null },
            ...(after ? { id: { gt: after } } : {}),
          },
          orderBy: { id: 'asc' },
          take: 100,
        });
        if (!rows.length) break;
        for (const row of rows)
          await this.prisma.$transaction(
            async (db) => {
              await db.$queryRaw`SELECT "id" FROM "BusinessTask" WHERE "id"=${row.id} FOR UPDATE`;
              const t = await db.businessTask.findUniqueOrThrow({
                where: { id: row.id },
              });
              if (
                !OPEN_STATUSES.includes(t.status) ||
                !t.dueAt ||
                !t.assignmentId ||
                !t.assigneeMemberId
              )
                return;
              const business = await db.business.findUnique({
                where: { id: t.businessId },
              });
              if (business?.status !== 'active') return;
              const assignment = await db.taskAssignment.findUniqueOrThrow({
                where: { id: t.assignmentId },
              });
              let identity: TaskIdentity;
              try {
                identity = await this.access.candidate(
                  t.businessId,
                  t.assigneeMemberId,
                  assignment.employeeId ?? undefined,
                  db,
                );
              } catch {
                return;
              }
              const type =
                t.dueAt < new Date() ? 'task_overdue' : 'task_due_soon';
              await db.userNotification.createMany({
                data: [
                  {
                    userId: identity.userId,
                    businessId: t.businessId,
                    type,
                    title:
                      type === 'task_overdue'
                        ? 'Task overdue'
                        : 'Task due soon',
                    message: t.title,
                    actionUrl: `/business/${t.businessId}/tasks/${t.id}`,
                    data: { taskId: t.id },
                    eventKey: `${type}:${t.id}:${t.assignmentId}:${t.dueAt.getTime()}`,
                  },
                ],
                skipDuplicates: true,
              });
            },
            { maxWait: 15000, timeout: 30000 },
          );
        after = rows.at(-1)!.id;
      }
    } finally {
      this.running = false;
    }
  }
}
