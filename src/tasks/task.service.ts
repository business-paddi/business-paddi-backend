import { BadRequestException, Injectable } from '@nestjs/common';
import type { BusinessTask, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TaskAccessService } from './task-access.service';
import type { TaskIdentity } from './task-access.service';
import { TaskEventsService } from './task-events.service';
import { TaskOperationService } from './task-operation.service';
import { TaskReadService } from './task-read.service';
import type {
  AssignmentDto,
  EvidenceDto,
  ReasonDto,
  ReviewDto,
  RevisionDto,
  SubmissionDto,
  TaskCreateDto,
  TaskPatchDto,
} from './task.dto';
import { conflict } from './task.utils';
@Injectable()
export class TaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TaskAccessService,
    private readonly events: TaskEventsService,
    private readonly operations: TaskOperationService,
    private readonly read: TaskReadService,
  ) {}
  revision(t: BusinessTask, r: number) {
    if (t.revision !== r) conflict('REVISION_MISMATCH', t);
  }
  transition(t: BusinessTask, allowed: string[]) {
    if (!allowed.includes(t.status)) conflict('INVALID_TASK_TRANSITION', t);
  }
  async create(
    userId: string,
    businessId: string,
    body: TaskCreateDto,
    key: string,
  ) {
    const pre = await this.access.context(userId, businessId);
    this.access.grant(pre, 'task:create');
    if (!key) throw new BadRequestException('Idempotency-Key required');
    const result = await this.operations.run(
      userId,
      key,
      { businessId, route: 'create', body },
      async (db) => {
        const a = await this.access.context(userId, businessId, db, true);
        this.access.grant(a, 'task:create');
        if (body.employeeId && !body.assigneeMemberId)
          throw new BadRequestException('employeeId requires assigneeMemberId');
        if (body.assigneeMemberId) this.access.grant(a, 'task:assign');
        if (body.requiresReview === false) this.access.grant(a, 'task:review');
        const actor = await this.access.identity(a, db);
        const requiresReview = body.requiresReview ?? true;
        if (requiresReview)
          await this.access.reviewer(
            businessId,
            body.reviewerMemberId ?? null,
            body.assigneeMemberId ?? null,
            db,
          );
        let t = await db.businessTask.create({
          data: {
            businessId,
            title: body.title,
            description: body.description,
            priority: body.priority,
            dueAt: body.dueAt ? new Date(body.dueAt) : null,
            createdByMemberId: a.member.id,
            creator: actor,
            requiresReview,
            reviewerMemberId: requiresReview ? body.reviewerMemberId : null,
          },
        });
        if (body.assigneeMemberId) {
          const identity = await this.access.candidate(
            businessId,
            body.assigneeMemberId,
            body.employeeId,
            db,
          );
          const assignment = await db.taskAssignment.create({
            data: {
              taskId: t.id,
              memberId: identity.memberId,
              employeeId: identity.employeeId,
              identity,
              cycle: 1,
              dueAt: t.dueAt,
            },
          });
          t = await db.businessTask.update({
            where: { id: t.id },
            data: {
              assigneeMemberId: identity.memberId,
              assignmentId: assignment.id,
              status: 'todo',
            },
          });
        }
        await this.events.record(db, t, actor, 'created', {
          recipients: t.assigneeMemberId ? [t.assigneeMemberId] : [],
          type: 'task_assigned',
        });
        return { taskId: t.id, snapshot: await this.read.snapshot(t, a, db) };
      },
    );
    await this.access.task(pre, result.taskId);
    return {
      task: await this.read.presentSnapshot(result.snapshot, businessId),
    };
  }
  async mutate(
    userId: string,
    businessId: string,
    taskId: string,
    route: string,
    body:
      | RevisionDto
      | EvidenceDto
      | TaskPatchDto
      | AssignmentDto
      | ReasonDto
      | ReviewDto,
    key?: string,
    attemptId?: string,
  ) {
    const pre = await this.access.context(userId, businessId);
    await this.access.task(pre, taskId);
    if (['submit', 'comment'].includes(route) && !key)
      throw new BadRequestException('Idempotency-Key required');
    const result = await this.operations.run(
      userId,
      key,
      { businessId, taskId, route, attemptId, body },
      async (db) => {
        const a = await this.access.context(userId, businessId, db, true);
        let t = await this.access.task(a, taskId, db, true);
        const before = {
          status: t.status,
          revision: t.revision,
          dueAt: t.dueAt?.toISOString() ?? null,
          assigneeMemberId: t.assigneeMemberId,
          assignmentId: t.assignmentId,
          reviewerMemberId: t.reviewerMemberId,
        };
        if ('revision' in body) this.revision(t, body.revision);
        const actor = await this.access.identity(a, db);
        let returnedAttemptId: string | undefined;
        let returnedAssignmentId: string | undefined;
        let commentId: string | undefined;
        const recipients = new Set<string>();
        const data: Prisma.BusinessTaskUpdateInput = {
          revision: { increment: 1 },
        };
        let event = route;
        let reason: string | undefined;
        let notificationType: string | undefined;
        switch (route) {
          case 'patch': {
            this.access.grant(a, 'task:update');
            const b = body as TaskPatchDto;
            if (['completed', 'cancelled'].includes(t.status))
              conflict('INVALID_TASK_TRANSITION', t);
            if (
              t.status === 'in_review' &&
              b.requiresReview !== undefined &&
              b.requiresReview !== t.requiresReview
            )
              conflict('REVIEW_PENDING', t);
            if (b.requiresReview === false) this.access.grant(a, 'task:review');
            const rr = b.requiresReview ?? t.requiresReview;
            const reviewer =
              b.reviewerMemberId !== undefined
                ? b.reviewerMemberId
                : t.reviewerMemberId;
            if (rr)
              await this.access.reviewer(
                businessId,
                reviewer ?? null,
                t.assigneeMemberId,
                db,
              );
            if (b.title !== undefined) data.title = b.title;
            if (b.description !== undefined) data.description = b.description;
            if (b.priority !== undefined) data.priority = b.priority;
            if (b.dueAt !== undefined)
              data.dueAt = b.dueAt ? new Date(b.dueAt) : null;
            data.requiresReview = rr;
            data.reviewerMemberId = rr ? reviewer : null;
            if (
              t.status === 'in_review' &&
              reviewer &&
              reviewer !== t.reviewerMemberId
            ) {
              recipients.add(reviewer);
              notificationType = 'task_submission_received';
            }
            event = 'updated';
            break;
          }
          case 'assign': {
            this.access.grant(a, 'task:assign');
            this.transition(t, [
              'unassigned',
              'todo',
              'in_progress',
              'in_review',
              'changes_requested',
              'failed',
            ]);
            const b = body as AssignmentDto;
            const identity = await this.access.candidate(
              businessId,
              b.assigneeMemberId,
              b.employeeId,
              db,
            );
            if (t.requiresReview)
              await this.access.reviewer(
                businessId,
                t.reviewerMemberId,
                identity.memberId,
                db,
              );
            if (t.assignmentId) {
              const old = await db.taskAssignment.findUniqueOrThrow({
                where: { id: t.assignmentId },
              });
              if (
                old.memberId === identity.memberId &&
                old.employeeId === identity.employeeId
              )
                conflict('DUPLICATE_ASSIGNMENT', t);
              if (!b.reason)
                throw new BadRequestException('Reassignment reason required');
              await db.taskAssignment.update({
                where: { id: old.id },
                data: { endedAt: new Date(), endReason: 'reassigned' },
              });
              await db.taskAttempt.updateMany({
                where: { assignmentId: old.id, status: 'submitted' },
                data: {
                  status: 'superseded',
                  reviewedAt: new Date(),
                  reviewedByMemberId: a.member.id,
                  reviewReason: b.reason,
                },
              });
              recipients.add(old.memberId);
              event = 'reassigned';
              notificationType = 'task_reassigned';
            } else {
              event = 'assigned';
              notificationType = 'task_assigned';
            }
            const count = await db.taskAssignment.count({ where: { taskId } });
            const assignment = await db.taskAssignment.create({
              data: {
                taskId,
                memberId: identity.memberId,
                employeeId: identity.employeeId,
                identity,
                cycle: count + 1,
                dueAt: t.dueAt,
              },
            });
            returnedAssignmentId = assignment.id;
            data.assignmentId = assignment.id;
            data.assigneeMemberId = identity.memberId;
            data.status = 'todo';
            data.completedAt = null;
            reason = b.reason;
            recipients.add(identity.memberId);
            break;
          }
          case 'start': {
            this.transition(t, ['todo', 'changes_requested']);
            const assignment = await this.access.ownAssignment(a, t, db);
            if (!assignment.startedAt)
              await db.taskAssignment.update({
                where: { id: assignment.id },
                data: { startedAt: new Date() },
              });
            data.status = 'in_progress';
            event = 'started';
            break;
          }
          case 'submit': {
            this.transition(t, ['todo', 'in_progress', 'changes_requested']);
            const assignment = await this.access.ownAssignment(a, t, db);
            if (t.requiresReview)
              await this.access.reviewer(
                businessId,
                t.reviewerMemberId,
                a.member.id,
                db,
              );
            const evidence = await this.evidence(
              db,
              t,
              userId,
              body as SubmissionDto,
            );
            const now = new Date();
            const attempt = await db.taskAttempt.create({
              data: {
                taskId,
                assignmentId: assignment.id,
                memberId: assignment.memberId,
                employeeId: assignment.employeeId,
                attemptNumber:
                  (await db.taskAttempt.count({
                    where: { assignmentId: assignment.id },
                  })) + 1,
                status: t.requiresReview ? 'submitted' : 'accepted',
                evidence,
                reviewedAt: t.requiresReview ? null : now,
              },
            });
            await this.attach(db, evidence, attempt.id);
            returnedAttemptId = attempt.id;
            data.status = t.requiresReview ? 'in_review' : 'completed';
            data.completedAt = t.requiresReview ? null : now;
            if (!t.requiresReview)
              await db.taskAssignment.update({
                where: { id: assignment.id },
                data: {
                  acceptedAt: now,
                  endedAt: now,
                  endReason: 'completed',
                  dueAt: t.dueAt,
                },
              });
            if (t.reviewerMemberId && t.requiresReview)
              recipients.add(t.reviewerMemberId);
            if (!t.requiresReview) recipients.add(t.createdByMemberId);
            event = 'submitted';
            notificationType = t.requiresReview
              ? 'task_submission_received'
              : 'task_completed';
            break;
          }
          case 'review': {
            this.access.grant(a, 'task:review');
            const b = body as ReviewDto;
            const attempt = await db.taskAttempt.findFirst({
              where: { id: attemptId, taskId },
            });
            if (
              !attempt ||
              attempt.status !== 'submitted' ||
              attempt.assignmentId !== t.assignmentId ||
              t.status !== 'in_review'
            )
              conflict('STALE_REVIEW', t);
            if (
              attempt.memberId === a.member.id ||
              t.reviewerMemberId !== a.member.id
            )
              throw new BadRequestException({
                code: 'INELIGIBLE_REVIEWER',
                message:
                  'Only the designated reviewer can review; self-review is prohibited',
              });
            await this.access.candidate(
              businessId,
              attempt.memberId,
              attempt.employeeId ?? undefined,
              db,
            );
            if (b.decision !== 'accept' && !b.reason)
              throw new BadRequestException('Review reason required');
            const now = new Date();
            const status =
              b.decision === 'accept'
                ? 'accepted'
                : b.decision === 'fail'
                  ? 'failed'
                  : 'changes_requested';
            await db.taskAttempt.update({
              where: { id: attempt.id },
              data: {
                status,
                reviewedAt: now,
                reviewedByMemberId: a.member.id,
                reviewReason: b.reason,
              },
            });
            data.status = status === 'accepted' ? 'completed' : status;
            data.completedAt = status === 'accepted' ? now : null;
            if (status === 'accepted')
              await db.taskAssignment.update({
                where: { id: attempt.assignmentId },
                data: {
                  acceptedAt: now,
                  endedAt: now,
                  endReason: 'completed',
                  dueAt: t.dueAt,
                },
              });
            returnedAttemptId = attempt.id;
            reason = b.reason;
            recipients.add(attempt.memberId);
            recipients.add(t.createdByMemberId);
            event = 'reviewed';
            notificationType =
              status === 'accepted' ? 'task_completed' : `task_${status}`;
            break;
          }
          case 'reopen': {
            this.access.grant(a, 'task:update');
            this.transition(t, ['completed', 'failed']);
            reason = (body as ReasonDto).reason;
            let identity: TaskIdentity | null = null;
            if (t.assignmentId) {
              const old = await db.taskAssignment.findUniqueOrThrow({
                where: { id: t.assignmentId },
              });
              try {
                identity = await this.access.candidate(
                  businessId,
                  old.memberId,
                  old.employeeId ?? undefined,
                  db,
                );
              } catch (e) {
                if (!(e instanceof BadRequestException)) throw e;
              }
              if (!old.endedAt)
                await db.taskAssignment.update({
                  where: { id: old.id },
                  data: { endedAt: new Date(), endReason: 'reopened' },
                });
            }
            if (identity) {
              if (t.requiresReview)
                await this.access.reviewer(
                  businessId,
                  t.reviewerMemberId,
                  identity.memberId,
                  db,
                );
              const assignment = await db.taskAssignment.create({
                data: {
                  taskId,
                  memberId: identity.memberId,
                  employeeId: identity.employeeId,
                  identity,
                  cycle:
                    (await db.taskAssignment.count({ where: { taskId } })) + 1,
                  dueAt: t.dueAt,
                },
              });
              data.assignmentId = assignment.id;
              data.assigneeMemberId = identity.memberId;
              data.status = 'todo';
              returnedAssignmentId = assignment.id;
              recipients.add(identity.memberId);
            } else {
              data.assignmentId = null;
              data.assigneeMemberId = null;
              data.status = 'unassigned';
            }
            data.completedAt = null;
            event = 'reopened';
            break;
          }
          case 'cancel': {
            this.access.grant(a, 'task:update');
            this.transition(t, [
              'unassigned',
              'todo',
              'in_progress',
              'in_review',
              'changes_requested',
              'failed',
            ]);
            reason = (body as ReasonDto).reason;
            if (t.assignmentId) {
              await db.taskAssignment.update({
                where: { id: t.assignmentId },
                data: {
                  endedAt: new Date(),
                  endReason: 'cancelled',
                  cancelled: true,
                },
              });
              await db.taskAttempt.updateMany({
                where: { assignmentId: t.assignmentId, status: 'submitted' },
                data: {
                  status: 'superseded',
                  reviewedAt: new Date(),
                  reviewedByMemberId: a.member.id,
                  reviewReason: reason,
                },
              });
            }
            data.status = 'cancelled';
            event = 'cancelled';
            if (t.assigneeMemberId) recipients.add(t.assigneeMemberId);
            break;
          }
          case 'comment': {
            if (!this.access.canComment(a, t))
              this.access.grant(a, 'task:update');
            if (t.assigneeMemberId === a.member.id)
              await this.access.ownAssignment(a, t, db);
            const evidence = await this.evidence(
              db,
              t,
              userId,
              body as EvidenceDto,
            );
            const c = await db.taskEntry.create({
              data: {
                taskId,
                kind: 'comment',
                event: 'commented',
                actor,
                data: evidence,
                assignmentId: t.assignmentId,
              },
            });
            await this.attach(db, evidence, c.id);
            commentId = c.id;
            event = 'commented';
            break;
          }
          default:
            throw new BadRequestException('Unknown action');
        }
        t = await db.businessTask.update({ where: { id: taskId }, data });
        await this.events.record(db, t, actor, event, {
          reason,
          attemptId: returnedAttemptId,
          recipients: [...recipients],
          type: notificationType,
          data: {
            before,
            after: {
              status: t.status,
              revision: t.revision,
              dueAt: t.dueAt?.toISOString() ?? null,
              assigneeMemberId: t.assigneeMemberId,
              assignmentId: t.assignmentId,
              reviewerMemberId: t.reviewerMemberId,
            },
            status: t.status,
            revision: t.revision,
            dueAt: t.dueAt?.toISOString() ?? null,
          },
        });
        return {
          taskId,
          attemptId: returnedAttemptId,
          assignmentId: returnedAssignmentId,
          commentId,
          snapshot: await this.read.snapshot(t, a, db),
          attempt: returnedAttemptId
            ? await db.taskAttempt.findUniqueOrThrow({
                where: { id: returnedAttemptId },
              })
            : null,
          assignment: returnedAssignmentId
            ? await db.taskAssignment.findUniqueOrThrow({
                where: { id: returnedAssignmentId },
              })
            : null,
          comment: commentId
            ? await db.taskEntry.findUniqueOrThrow({ where: { id: commentId } })
            : null,
        };
      },
    );
    const response = {
      task: await this.read.presentSnapshot(result.snapshot, businessId),
    };
    return {
      ...response,
      ...(result.attempt
        ? {
            attempt: await this.read.presentAttempt(result.attempt, businessId),
          }
        : {}),
      ...(result.assignment
        ? {
            assignment: result.assignment,
          }
        : {}),
      ...(result.comment
        ? {
            comment: await this.read.presentComment(result.comment, businessId),
          }
        : {}),
    };
  }
  async evidence(
    db: Prisma.TransactionClient,
    t: BusinessTask,
    userId: string,
    b: EvidenceDto,
  ): Promise<Prisma.InputJsonObject> {
    const ids = b.imageIds ?? [];
    if (!b.notes?.trim() && !b.links?.length && !ids.length)
      throw new BadRequestException({
        code: 'EVIDENCE_REQUIRED',
        message: 'Provide notes, a link, or a finalized image',
      });
    const images = await db.taskImage.findMany({
      where: {
        id: { in: ids },
        taskId: t.id,
        uploadedByUserId: userId,
        status: 'finalized',
        attachedTo: null,
      },
    });
    if (images.length !== ids.length)
      throw new BadRequestException('Image is unavailable or already attached');
    return {
      notes: b.notes?.trim() || null,
      links: (b.links ?? []).map((l) => ({
        label: l.label ?? null,
        url: l.url,
      })),
      imageIds: ids,
    };
  }
  async attach(
    db: Prisma.TransactionClient,
    e: Prisma.InputJsonObject,
    id: string,
  ) {
    const ids = e.imageIds as string[];
    if (ids.length)
      await db.taskImage.updateMany({
        where: { id: { in: ids }, attachedTo: null },
        data: { attachedTo: id, status: 'attached' },
      });
  }
}
