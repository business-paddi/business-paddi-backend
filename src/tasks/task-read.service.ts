import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BusinessTask, Prisma } from '../../generated/prisma/client';
import type { Access } from '../business/business-access.service';
import { PrismaService } from '../database/prisma.service';
import { TaskAccessService } from './task-access.service';
import { TaskOperationService } from './task-operation.service';
import { TaskImagesService } from './task-images.service';
import type {
  AssigneeQueryDto,
  PageDto,
  ReviewerQueryDto,
  TaskQueryDto,
} from './task.dto';
import { decodeCursor, encodeCursor, OPEN_STATUSES } from './task.utils';
@Injectable()
export class TaskReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TaskAccessService,
    private readonly operations: TaskOperationService,
    private readonly images: TaskImagesService,
  ) {}
  async summary(
    t: BusinessTask,
    a: Access,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const assignment = t.assignmentId
      ? await db.taskAssignment.findUnique({ where: { id: t.assignmentId } })
      : null;
    const latest = await db.taskAttempt.findFirst({
      where: { taskId: t.id },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    });
    let eligible = false;
    if (assignment) {
      try {
        await this.access.candidate(
          t.businessId,
          assignment.memberId,
          assignment.employeeId ?? undefined,
          db,
          false,
        );
        eligible = true;
      } catch {
        eligible = false;
      }
    }
    const own = t.assigneeMemberId === a.member.id && eligible;
    const update = a.permissions.includes('task:update');
    const assign = a.permissions.includes('task:assign');
    const mutable = !['completed', 'cancelled'].includes(t.status);
    return {
      id: t.id,
      businessId: t.businessId,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueAt: t.dueAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      completedAt: t.completedAt,
      revision: t.revision,
      business: {
        id: a.member.business.id,
        name: a.member.business.name,
        profileImage: a.member.business.profileImage,
      },
      createdBy: t.creator,
      assignee: assignment?.identity ?? null,
      assignmentId: t.assignmentId,
      requiresReview: t.requiresReview,
      reviewerMemberId: t.reviewerMemberId,
      attemptCount: await db.taskAttempt.count({ where: { taskId: t.id } }),
      latestAttemptStatus: latest?.status ?? null,
      isOverdue:
        OPEN_STATUSES.includes(t.status) && !!t.dueAt && t.dueAt < new Date(),
      viewerRelation:
        t.assigneeMemberId === a.member.id
          ? 'assignee'
          : t.createdByMemberId === a.member.id
            ? 'creator'
            : 'manager',
      capabilities: {
        canEdit: update && mutable,
        canAssign: assign && mutable,
        canStart: own && ['todo', 'changes_requested'].includes(t.status),
        canSubmit:
          own &&
          ['todo', 'in_progress', 'changes_requested'].includes(t.status),
        canReview:
          eligible &&
          a.permissions.includes('task:review') &&
          t.reviewerMemberId === a.member.id &&
          t.status === 'in_review' &&
          latest?.memberId !== a.member.id,
        canReopen: update && ['completed', 'failed'].includes(t.status),
        canCancel: update && mutable,
        canComment:
          this.access.canComment(a, t) &&
          (t.assigneeMemberId === a.member.id ? eligible : true),
      },
    };
  }
  async detail(userId: string, businessId: string, taskId: string) {
    const a = await this.access.context(userId, businessId);
    const t = await this.access.task(a, taskId);
    return {
      task: await this.presentSnapshot(
        await this.snapshot(t, a, this.prisma),
        businessId,
      ),
    };
  }
  async snapshot(t: BusinessTask, a: Access, db: Prisma.TransactionClient) {
    const taskId = t.id;
    const assignments = await db.taskAssignment.findMany({
      where: { taskId },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    const latest = await db.taskAttempt.findFirst({
      where: { taskId },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    });
    return {
      ...(await this.summary(t, a, db)),
      description: t.description,
      assignmentHistory: assignments,
      assignmentHistoryHasMore:
        (await db.taskAssignment.count({ where: { taskId } })) > 10,
      latestAttempt: latest,
    };
  }
  async presentSnapshot(
    snapshot: Awaited<ReturnType<TaskReadService['snapshot']>>,
    businessId: string,
  ) {
    return {
      ...snapshot,
      latestAttempt: snapshot.latestAttempt
        ? {
            ...snapshot.latestAttempt,
            evidence: await this.images.evidence(
              this.prisma,
              snapshot.latestAttempt.evidence,
              businessId,
            ),
          }
        : null,
    };
  }
  async presentAttempt(
    attempt: Awaited<
      ReturnType<PrismaService['taskAttempt']['findFirstOrThrow']>
    >,
    businessId: string,
  ) {
    return {
      ...attempt,
      evidence: await this.images.evidence(
        this.prisma,
        attempt.evidence,
        businessId,
      ),
    };
  }
  async presentComment(
    c: Awaited<ReturnType<PrismaService['taskEntry']['findFirstOrThrow']>>,
    businessId: string,
  ) {
    return {
      id: c.id,
      author: c.actor,
      createdAt: c.createdAt,
      ...(await this.images.evidence(this.prisma, c.data, businessId)),
    };
  }
  async attempt(
    userId: string,
    businessId: string,
    taskId: string,
    attemptId: string,
  ) {
    const a = await this.access.context(userId, businessId);
    await this.access.task(a, taskId);
    const attempt = await this.prisma.taskAttempt.findFirstOrThrow({
      where: { id: attemptId, taskId },
    });
    return {
      ...attempt,
      evidence: await this.images.evidence(
        this.prisma,
        attempt.evidence,
        businessId,
      ),
    };
  }
  async comment(
    userId: string,
    businessId: string,
    taskId: string,
    commentId: string,
  ) {
    const a = await this.access.context(userId, businessId);
    await this.access.task(a, taskId);
    const c = await this.prisma.taskEntry.findFirstOrThrow({
      where: { id: commentId, taskId, kind: 'comment' },
    });
    return {
      id: c.id,
      author: c.actor,
      createdAt: c.createdAt,
      ...(await this.images.evidence(this.prisma, c.data, businessId)),
    };
  }
  async collection(
    userId: string,
    businessId: string,
    taskId: string,
    kind: 'attempts' | 'history' | 'comments' | 'assignments',
    q: PageDto,
  ) {
    const a = await this.access.context(userId, businessId);
    await this.access.task(a, taskId);
    const filter = { userId, businessId, taskId, kind };
    const position = decodeCursor<{ at: string; id: string }>(
      this.operations.secret,
      filter,
      q.cursor,
    );
    const key =
      kind === 'attempts'
        ? 'submittedAt'
        : kind === 'assignments'
          ? 'assignedAt'
          : 'createdAt';
    const after = position
      ? {
          OR: [
            { [key]: { lt: new Date(position.at) } },
            { [key]: new Date(position.at), id: { lt: position.id } },
          ],
        }
      : {};
    let rows: Array<{ id: string; [key: string]: unknown }>;
    if (kind === 'attempts')
      rows = await this.prisma.taskAttempt.findMany({
        where: { taskId, ...after },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
    else if (kind === 'assignments')
      rows = await this.prisma.taskAssignment.findMany({
        where: { taskId, ...after },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
    else
      rows = await this.prisma.taskEntry.findMany({
        where: {
          taskId,
          kind: kind === 'comments' ? 'comment' : 'history',
          ...after,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
    const more = rows.length > q.limit;
    rows = rows.slice(0, q.limit);
    const last = rows.at(-1);
    const items = await Promise.all(
      rows.map(async (r) =>
        kind === 'attempts'
          ? {
              ...r,
              evidence: await this.images.evidence(
                this.prisma,
                r.evidence as Prisma.JsonValue,
                businessId,
              ),
            }
          : kind === 'comments'
            ? {
                id: r.id,
                author: r.actor,
                createdAt: r.createdAt,
                ...(await this.images.evidence(
                  this.prisma,
                  r.data as Prisma.JsonValue,
                  businessId,
                )),
              }
            : r,
      ),
    );
    return {
      items,
      nextCursor:
        more && last
          ? encodeCursor(this.operations.secret, filter, {
              at: (last[key] as Date).toISOString(),
              id: last.id,
            })
          : null,
    };
  }
  async contexts(userId: string, businessId?: string) {
    if (businessId) return [await this.access.context(userId, businessId)];
    const members = await this.prisma.businessMember.findMany({
      where: {
        userId,
        status: 'active',
        approvalStatus: { in: ['approved', 'not_required'] },
        role: { status: 'active' },
        business: { status: 'active' },
      },
      select: { businessId: true },
    });
    const contexts: Access[] = [];
    for (const m of members) {
      try {
        contexts.push(await this.access.context(userId, m.businessId));
      } catch (error) {
        if (
          !(error instanceof ForbiddenException) &&
          !(error instanceof NotFoundException)
        )
          throw error;
      }
    }
    return contexts;
  }
  async list(
    userId: string,
    businessId: string | undefined,
    q: TaskQueryDto,
    dashboard = false,
  ) {
    const contexts = await this.contexts(userId, businessId ?? q.businessId);
    const filter = {
      userId,
      businessId: businessId ?? null,
      ...q,
      cursor: undefined,
      limit: undefined,
    };
    const position = decodeCursor<{ at: string | null; id: string }>(
      this.operations.secret,
      filter,
      q.cursor,
    );
    if (q.dueFrom && q.dueTo && new Date(q.dueFrom) >= new Date(q.dueTo))
      throw new BadRequestException('dueFrom must precede dueTo');
    if (!contexts.length) {
      return dashboard
        ? {
            items: [],
            nextCursor: null,
            summary: {
              visibleCount: 0,
              assignedToMeCount: 0,
              businessCount: 0,
              unassignedCount: 0,
              todoCount: 0,
              inProgressCount: 0,
              inReviewCount: 0,
              changesRequestedCount: 0,
              completedCount: 0,
              failedCount: 0,
              cancelledCount: 0,
              overdueCount: 0,
            },
          }
        : { items: [], nextCursor: null };
    }
    const visibility = contexts.map((a) => {
      const w: Prisma.BusinessTaskWhereInput = {
        businessId: a.member.businessId,
      };
      if (q.scope === 'assigned_to_me') w.assigneeMemberId = a.member.id;
      else if (q.scope === 'created_by_me') w.createdByMemberId = a.member.id;
      else if (!a.permissions.includes('task:view'))
        w.OR = [
          { assigneeMemberId: a.member.id },
          { createdByMemberId: a.member.id },
          ...(a.permissions.includes('task:review')
            ? [{ reviewerMemberId: a.member.id }]
            : []),
        ];
      return w;
    });
    const and: Prisma.BusinessTaskWhereInput[] = [{ OR: visibility }];
    if (q.q)
      and.push({
        OR: [
          { title: { contains: q.q, mode: 'insensitive' } },
          { description: { contains: q.q, mode: 'insensitive' } },
        ],
      });
    if (q.status) and.push({ status: q.status });
    if (q.priority) and.push({ priority: q.priority });
    if (q.assigneeMemberId) and.push({ assigneeMemberId: q.assigneeMemberId });
    if (q.createdByMemberId)
      and.push({ createdByMemberId: q.createdByMemberId });
    if (q.employeeId) {
      const assignments = await this.prisma.taskAssignment.findMany({
        where: {
          employeeId: q.employeeId,
          task: {
            businessId: { in: contexts.map((a) => a.member.businessId) },
          },
        },
        select: { id: true },
      });
      and.push({ assignmentId: { in: assignments.map((a) => a.id) } });
    }
    const now = new Date();
    if (q.overdue === 'true')
      and.push({ status: { in: OPEN_STATUSES }, dueAt: { lt: now } });
    if (q.overdue === 'false')
      and.push({
        OR: [
          { status: { notIn: OPEN_STATUSES } },
          { dueAt: null },
          { dueAt: { gte: now } },
        ],
      });
    if (q.dueFrom || q.dueTo)
      and.push({
        dueAt: {
          ...(q.dueFrom ? { gte: new Date(q.dueFrom) } : {}),
          ...(q.dueTo ? { lt: new Date(q.dueTo) } : {}),
        },
      });
    const where: Prisma.BusinessTaskWhereInput = { AND: and };
    const paged: Prisma.BusinessTaskWhereInput = { AND: [...and] };
    if (position) {
      const p =
        q.sort === 'dueAt_asc'
          ? position.at === null
            ? { dueAt: null, id: { gt: position.id } }
            : {
                OR: [
                  { dueAt: { gt: new Date(position.at) } },
                  { dueAt: new Date(position.at), id: { gt: position.id } },
                  { dueAt: null },
                ],
              }
          : {
              OR: [
                { updatedAt: { lt: new Date(position.at!) } },
                { updatedAt: new Date(position.at!), id: { lt: position.id } },
              ],
            };
      (paged.AND as Prisma.BusinessTaskWhereInput[]).push(p);
    }
    const rows = await this.prisma.businessTask.findMany({
      where: paged,
      orderBy:
        q.sort === 'dueAt_asc'
          ? [{ dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]
          : [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    const items = await Promise.all(
      page.map((t) =>
        this.summary(
          t,
          contexts.find((a) => a.member.businessId === t.businessId)!,
        ),
      ),
    );
    const nextCursor =
      more && last
        ? encodeCursor(this.operations.secret, filter, {
            at:
              (q.sort === 'dueAt_asc'
                ? last.dueAt
                : last.updatedAt
              )?.toISOString() ?? null,
            id: last.id,
          })
        : null;
    if (!dashboard) return { items, nextCursor };
    const counts = await this.prisma.businessTask.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const summary: Record<string, number> = {
      visibleCount: counts.reduce((s, c) => s + c._count._all, 0),
      assignedToMeCount: await this.prisma.businessTask.count({
        where: {
          AND: [
            where,
            { assigneeMemberId: { in: contexts.map((a) => a.member.id) } },
          ],
        },
      }),
      businessCount: (
        await this.prisma.businessTask.groupBy({ by: ['businessId'], where })
      ).length,
      overdueCount: await this.prisma.businessTask.count({
        where: {
          AND: [where, { status: { in: OPEN_STATUSES }, dueAt: { lt: now } }],
        },
      }),
    };
    for (const [status, key] of Object.entries({
      unassigned: 'unassignedCount',
      todo: 'todoCount',
      in_progress: 'inProgressCount',
      in_review: 'inReviewCount',
      changes_requested: 'changesRequestedCount',
      completed: 'completedCount',
      failed: 'failedCount',
      cancelled: 'cancelledCount',
    }))
      summary[key] = counts.find((c) => c.status === status)?._count._all ?? 0;
    return { items, nextCursor, summary };
  }
  async reviewers(userId: string, businessId: string, q: ReviewerQueryDto) {
    const a = await this.access.context(userId, businessId);
    if (
      !['task:create', 'task:assign', 'task:update', 'task:review'].some((p) =>
        a.permissions.includes(p),
      )
    )
      this.access.grant(a, 'task:create');
    const filter = {
      userId,
      businessId,
      kind: 'reviewer',
      q: q.q ?? null,
      assigneeMemberId: q.assigneeMemberId ?? null,
    };
    const cursor = decodeCursor<{ id: string }>(
      this.operations.secret,
      filter,
      q.cursor,
    );
    const rows = await this.prisma.businessMember.findMany({
      where: {
        businessId,
        status: 'active',
        approvalStatus: { in: ['approved', 'not_required'] },
        role: {
          status: 'active',
          permissions: { some: { permission: 'task:review' } },
          deniedPermissions: { none: { permission: 'task:review' } },
        },
        user: {
          status: 'active',
          emailVerifiedAt: { not: null },
          ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
        },
        ...(q.assigneeMemberId ? { NOT: { id: q.assigneeMemberId } } : {}),
        ...(cursor ? { id: { gt: cursor.id } } : {}),
      },
      include: { user: { select: { id: true, name: true, avatar: true } } },
      orderBy: { id: 'asc' },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((m) => ({
        memberId: m.id,
        userId: m.userId,
        name: m.user.name,
        avatar: m.user.avatar,
      })),
      nextCursor:
        rows.length > q.limit
          ? encodeCursor(this.operations.secret, filter, {
              id: page.at(-1)!.id,
            })
          : null,
    };
  }
  async assignees(userId: string, businessId: string, q: AssigneeQueryDto) {
    const a = await this.access.context(userId, businessId);
    this.access.grant(a, 'task:assign');
    const filter = { userId, businessId, kind: q.kind, q: q.q ?? null };
    const cursor = decodeCursor<{ id: string }>(
      this.operations.secret,
      filter,
      q.cursor,
    );
    const rows = await this.prisma.businessMember.findMany({
      where: {
        businessId,
        status: 'active',
        approvalStatus: { in: ['approved', 'not_required'] },
        role: { status: 'active' },
        user: {
          status: 'active',
          emailVerifiedAt: { not: null },
          ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
        },
        ...(q.kind === 'employee'
          ? { employee: { is: { status: 'active' } } }
          : {}),
        ...(cursor ? { id: { gt: cursor.id } } : {}),
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        employee: { select: { id: true, fullName: true, status: true } },
      },
      orderBy: { id: 'asc' },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((m) => ({
        memberId: m.id,
        userId: m.userId,
        name: m.user.name,
        avatar: m.user.avatar,
        employeeId:
          q.kind !== 'member' && m.employee?.status === 'active'
            ? m.employee.id
            : null,
        employeeName:
          q.kind !== 'member' && m.employee?.status === 'active'
            ? m.employee.fullName
            : null,
        kind:
          q.kind !== 'member' && m.employee?.status === 'active'
            ? 'employee'
            : 'member',
      })),
      nextCursor:
        rows.length > q.limit
          ? encodeCursor(this.operations.secret, filter, {
              id: page.at(-1)!.id,
            })
          : null,
    };
  }
}
