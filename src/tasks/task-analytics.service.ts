import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TaskAccessService } from './task-access.service';
import { TaskOperationService } from './task-operation.service';
import type { AnalyticsQueryDto } from './task.dto';
import { decodeCursor, encodeCursor } from './task.utils';
const counters = [
  'assignmentCount',
  'startedCount',
  'submittedAttemptCount',
  'acceptedAttemptCount',
  'failedAttemptCount',
  'changesRequestedAttemptCount',
  'reassignedAwayCount',
  'reassignedInCount',
  'redoAttemptCount',
  'reopenedTaskCount',
  'cancelledAssignmentCount',
  'openCount',
  'overdueCount',
  'completedTaskCount',
  'onTimeCompletedTaskCount',
] as const;
type Stats = Record<(typeof counters)[number], number> & {
  completedAssignments: number;
  eligibleAssignments: number;
  firstAccepted: number;
  firstReviewed: number;
  onTime: number;
  datedAccepted: number;
  durationSeconds: number;
  durationSamples: number;
  completedTasks: Set<string>;
  onTimeTasks: Set<string>;
  reopenedTasks: Set<string>;
};
const blank = (): Stats =>
  ({
    ...Object.fromEntries(counters.map((k) => [k, 0])),
    completedAssignments: 0,
    eligibleAssignments: 0,
    firstAccepted: 0,
    firstReviewed: 0,
    onTime: 0,
    datedAccepted: 0,
    durationSeconds: 0,
    durationSamples: 0,
    completedTasks: new Set<string>(),
    onTimeTasks: new Set<string>(),
    reopenedTasks: new Set<string>(),
  }) as Stats;
export function ratio(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
  };
}
@Injectable()
export class TaskAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TaskAccessService,
    private readonly operations: TaskOperationService,
  ) {}
  async report(userId: string, businessId: string, q: AnalyticsQueryDto) {
    const a = await this.access.context(userId, businessId);
    if (q.scope !== 'me') this.access.grant(a, 'task:report');
    if (q.scope === 'me' && q.memberId && q.memberId !== a.member.id)
      throw new ForbiddenException('Only your own analytics are available');
    const asOf = new Date();
    const to = q.to ? new Date(q.to) : asOf;
    const from = q.from
      ? new Date(q.from)
      : new Date(to.getTime() - 30 * 86400000);
    if (from >= to) throw new BadRequestException('from must precede to');
    // Default periods are pinned in cursors so navigating does not change the time bounds.
    const cursorFilter = {
      userId,
      businessId,
      from: q.from ?? null,
      to: q.to ?? null,
      groupBy: q.groupBy,
      scope: q.scope,
      memberId: q.memberId ?? null,
      employeeId: q.employeeId ?? null,
    };
    const cursor = decodeCursor<{
      id: string;
      from: string;
      to: string;
      asOf: string;
    }>(this.operations.secret, cursorFilter, q.cursor);
    const lower = cursor ? new Date(cursor.from) : from,
      upper = cursor ? new Date(cursor.to) : to,
      measuredAt = cursor ? new Date(cursor.asOf) : asOf;
    const inPeriod = (d: Date | null) =>
      !!d && d >= lower && d < upper && d <= measuredAt;
    const assignments = await this.prisma.taskAssignment.findMany({
      where: {
        task: { businessId },
        ...(q.scope === 'me'
          ? { memberId: a.member.id }
          : q.memberId
            ? { memberId: q.memberId }
            : {}),
        ...(q.employeeId ? { employeeId: q.employeeId } : {}),
        ...(q.groupBy === 'employee'
          ? {
              employeeId: {
                not: null,
                ...(q.employeeId ? { equals: q.employeeId } : {}),
              },
            }
          : {}),
      },
      include: {
        attempts: true,
        task: {
          select: { id: true, dueAt: true, status: true, assignmentId: true },
        },
      },
      orderBy: { id: 'asc' },
    });
    const rows = new Map<string, { identity: unknown; stats: Stats }>();
    const total = blank();
    for (const assignment of assignments) {
      const id =
        q.groupBy === 'employee' ? assignment.employeeId! : assignment.memberId;
      let row = rows.get(id);
      if (!row) {
        row = { identity: assignment.identity, stats: blank() };
        rows.set(id, row);
      }
      const apply = (s: Stats) => {
        const cohort = inPeriod(assignment.assignedAt);
        if (cohort) {
          s.assignmentCount++;
          if (
            assignment.cancelled &&
            assignment.endedAt &&
            assignment.endedAt <= measuredAt
          )
            s.cancelledAssignmentCount++;
          else s.eligibleAssignments++;
          if (assignment.acceptedAt && assignment.acceptedAt <= measuredAt) {
            s.completedAssignments++;
            s.completedTasks.add(assignment.taskId);
            if (assignment.dueAt) {
              s.datedAccepted++;
              if (assignment.acceptedAt <= assignment.dueAt) {
                s.onTime++;
                s.onTimeTasks.add(assignment.taskId);
              }
            }
            s.durationSeconds +=
              (assignment.acceptedAt.getTime() -
                assignment.assignedAt.getTime()) /
              1000;
            s.durationSamples++;
          }
          if (!assignment.endedAt || assignment.endedAt > measuredAt) {
            s.openCount++;
            if (assignment.task.dueAt && assignment.task.dueAt < measuredAt)
              s.overdueCount++;
          }
        }
        if (inPeriod(assignment.startedAt)) s.startedCount++;
        if (
          inPeriod(assignment.endedAt) &&
          assignment.endReason === 'reassigned'
        )
          s.reassignedAwayCount++;
        if (assignment.cycle > 1 && inPeriod(assignment.assignedAt)) {
          // Reopened and reassigned cycles are distinguished by the originating history event below.
        }
        for (const attempt of assignment.attempts) {
          if (inPeriod(attempt.submittedAt)) {
            s.submittedAttemptCount++;
            if (attempt.attemptNumber > 1) s.redoAttemptCount++;
          }
          if (inPeriod(attempt.reviewedAt)) {
            if (attempt.status === 'accepted') s.acceptedAttemptCount++;
            if (attempt.status === 'failed') s.failedAttemptCount++;
            if (attempt.status === 'changes_requested')
              s.changesRequestedAttemptCount++;
          }
          if (
            attempt.attemptNumber === 1 &&
            inPeriod(attempt.submittedAt) &&
            attempt.reviewedAt &&
            attempt.reviewedAt <= measuredAt &&
            ['accepted', 'failed', 'changes_requested'].includes(attempt.status)
          ) {
            s.firstReviewed++;
            if (attempt.status === 'accepted') s.firstAccepted++;
          }
        }
      };
      apply(row.stats);
      apply(total);
    }
    const events = await this.prisma.taskEntry.findMany({
      where: {
        task: { businessId },
        kind: 'history',
        event: { in: ['reassigned', 'reopened'] },
        createdAt: { gte: lower, lt: upper, lte: measuredAt },
      },
      select: { taskId: true, assignmentId: true, event: true },
    });
    const byAssignment = new Map(assignments.map((x) => [x.id, x]));
    for (const e of events) {
      const assignment = e.assignmentId
        ? byAssignment.get(e.assignmentId)
        : undefined;
      if (!assignment) continue;
      const row = rows.get(
        q.groupBy === 'employee' ? assignment.employeeId! : assignment.memberId,
      );
      if (!row) continue;
      if (e.event === 'reassigned') {
        row.stats.reassignedInCount++;
        total.reassignedInCount++;
      } else {
        row.stats.reopenedTasks.add(e.taskId);
        total.reopenedTasks.add(e.taskId);
      }
    }
    const finish = (s: Stats) => ({
      ...(Object.fromEntries(counters.map((k) => [k, s[k]])) as Record<
        (typeof counters)[number],
        number
      >),
      completedTaskCount: s.completedTasks.size,
      onTimeCompletedTaskCount: s.onTimeTasks.size,
      reopenedTaskCount: s.reopenedTasks.size,
      excludedCancelledCount: s.cancelledAssignmentCount,
      completionRate: ratio(s.completedAssignments, s.eligibleAssignments),
      firstPassAcceptanceRate: ratio(s.firstAccepted, s.firstReviewed),
      onTimeCompletionRate: ratio(s.onTime, s.datedAccepted),
      averageCompletionSeconds: {
        totalSeconds: s.durationSeconds,
        sampleCount: s.durationSamples,
        value: s.durationSamples ? s.durationSeconds / s.durationSamples : null,
      },
    });
    const sorted = [...rows].sort(([a], [b]) => a.localeCompare(b));
    const page = sorted
      .filter(([id]) => !cursor || id > cursor.id)
      .slice(0, q.limit + 1);
    const more = page.length > q.limit;
    const selected = page.slice(0, q.limit);
    return {
      period: {
        from: lower.toISOString(),
        to: upper.toISOString(),
        asOf: measuredAt.toISOString(),
        bounds: '[from,to)',
      },
      definitions: {
        cohort:
          'Assignments created in period; accepted completion measured as of response. Cancelled assignments excluded; reassigned-away assignments remain.',
        events:
          'Start, submission, review, reassignment and redo counters use their event timestamp.',
        duration:
          'Assignment assignedAt to acceptedAt; work startedAt is reported separately.',
        deadline:
          'dueAt snapshot captured at acceptance; prior edits appear in task history.',
        rates: 'Fraction 0..1, null when denominator is zero.',
      },
      totals: finish(total),
      items: selected.map(([id, r]) => ({
        id,
        identity: r.identity,
        ...finish(r.stats),
      })),
      nextCursor: more
        ? encodeCursor(this.operations.secret, cursorFilter, {
            id: selected.at(-1)![0],
            from: lower.toISOString(),
            to: upper.toISOString(),
            asOf: measuredAt.toISOString(),
          })
        : null,
    };
  }
}
