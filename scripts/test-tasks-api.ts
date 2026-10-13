import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { BusinessAccessService } from '../src/business/business-access.service';
import type { PrismaService } from '../src/database/prisma.service';
import { TaskAccessService } from '../src/tasks/task-access.service';
import { TaskEventsService } from '../src/tasks/task-events.service';
import { TaskOperationService } from '../src/tasks/task-operation.service';
import { TaskImagesService } from '../src/tasks/task-images.service';
import { TaskReadService } from '../src/tasks/task-read.service';
import { TaskService } from '../src/tasks/task.service';
import { TaskAnalyticsService } from '../src/tasks/task-analytics.service';
import { TaskReminderService } from '../src/tasks/task-reminder.service';
import {
  AnalyticsQueryDto,
  AssigneeQueryDto,
  PageDto,
  TaskQueryDto,
} from '../src/tasks/task.dto';
import { ContactService } from '../src/public-contact/contact.service';
import { seedSystemRoles } from '../src/business-foundation/seed';
import { ReviewerQueryDto } from '../src/tasks/task.dto';
import { createHmac } from 'node:crypto';
import { databaseErrorSummary } from './database-error';
async function main() {
  const schema = `tasks_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30000,
  });
  const url = new URL(process.env.DATABASE_URL!);
  url.hostname = url.hostname.replace('-pooler.', '.');
  const pool = new Pool({
    connectionString: url.toString(),
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 30000,
  });
  let prisma: PrismaClient | undefined,
    created = false,
    passed = 0;
  const check = (name: string, value: unknown) => {
    assert.ok(value, name);
    passed++;
    console.log(`PASS: ${name}`);
  };
  const rejects = async (
    name: string,
    work: () => Promise<unknown>,
    status?: number,
  ) => {
    try {
      await work();
    } catch (e) {
      if (status) assert.equal((e as HttpException).getStatus(), status);
      check(name, true);
      return;
    }
    throw new Error(`Expected rejection: ${name}`);
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    assert.equal(
      (await pool.query('SELECT current_schema() AS s')).rows[0].s,
      schema,
    );
    for (const entry of (
      await readdir('prisma/migrations', { withFileTypes: true })
    )
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      let sql = (
        await readFile(`prisma/migrations/${entry.name}/migration.sql`, 'utf8')
      ).replace('CREATE SCHEMA IF NOT EXISTS "public";', '');
      const addition = sql.match(
        /^ALTER TYPE "BusinessMemberStatus" ADD VALUE IF NOT EXISTS 'pending_approval';/,
      );
      if (addition) {
        await pool.query(addition[0]);
        sql = sql.slice(addition[0].length);
      }
      await pool.query(sql);
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    const db = prisma as unknown as PrismaService;
    const config = new ConfigService({
      VERIFICATION_CODE_PEPPER: 'isolated-test-pepper',
      CLOUDINARY_CLOUD_NAME: 'test',
      CLOUDINARY_API_KEY: 'test',
      CLOUDINARY_API_SECRET: 'test',
    });
    const access = new TaskAccessService(db, new BusinessAccessService(db));
    const operations = new TaskOperationService(db, config);
    const images = new TaskImagesService(db, access, config);
    const read = new TaskReadService(db, access, operations, images);
    const tasks = new TaskService(
      db,
      access,
      new TaskEventsService(),
      operations,
      read,
    );
    const analytics = new TaskAnalyticsService(db, access, operations);
    const reminders = new TaskReminderService(db, access);
    const contacts = new ContactService(db, config);
    for (const id of [
      'manager',
      'alice',
      'bob',
      'creator',
      'outsider',
      'assigner',
    ])
      await prisma.user.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          name: id,
          emailVerifiedAt: new Date(),
        },
      });
    await prisma.business.createMany({
      data: [
        { id: 'b', name: 'Test business' },
        { id: 'other', name: 'Other business' },
      ],
    });
    for (const [id, businessId, permissions] of [
      [
        'management',
        'b',
        [
          'task:create',
          'task:assign',
          'task:view',
          'task:update',
          'task:review',
          'task:report',
        ],
      ],
      ['worker', 'b', []],
      ['creator-role', 'b', ['task:create']],
      ['assigner-role', 'b', ['task:assign']],
      ['foreign-role', 'other', []],
    ] as Array<[string, string, string[]]>) {
      await prisma.role.create({
        data: {
          id,
          businessId,
          key: id.replaceAll('-', '_'),
          name: id,
          type: 'custom',
          permissions: {
            create: permissions.map((permission) => ({ permission })),
          },
        },
      });
    }
    for (const [id, userId, roleId, businessId] of [
      ['mm', 'manager', 'management', 'b'],
      ['ma', 'alice', 'worker', 'b'],
      ['mb', 'bob', 'worker', 'b'],
      ['mc', 'creator', 'creator-role', 'b'],
      ['mx', 'assigner', 'assigner-role', 'b'],
      ['mo', 'outsider', 'foreign-role', 'other'],
    ])
      await prisma.businessMember.create({
        data: { id, userId, roleId, businessId },
      });
    const type = await prisma.employeeType.create({
      data: { businessId: 'b', key: 'worker', name: 'Worker' },
    });
    await prisma.businessEmployee.createMany({
      data: [
        {
          id: 'ea',
          businessId: 'b',
          businessMemberId: 'ma',
          employeeTypeId: type.id,
          fullName: 'Alice employee',
          email: 'alice@example.invalid',
          state: 'Lagos',
        },
        {
          id: 'unconnected',
          businessId: 'b',
          employeeTypeId: type.id,
          fullName: 'Unconnected',
          email: 'unconnected@example.invalid',
          state: 'Lagos',
        },
      ],
    });
    const create = async (
      title: string,
      overrides: Record<string, unknown> = {},
    ) =>
      tasks.create(
        'manager',
        'b',
        {
          title,
          assigneeMemberId: 'ma',
          employeeId: 'ea',
          reviewerMemberId: 'mm',
          ...overrides,
        },
        randomBytes(8).toString('hex'),
      );
    await rejects(
      'create assigned task requires task:assign',
      () =>
        tasks.create(
          'creator',
          'b',
          { title: 'Denied', assigneeMemberId: 'ma', reviewerMemberId: 'mm' },
          'denied',
        ),
      403,
    );
    const unassigned = await tasks.create(
      'creator',
      'b',
      { title: 'Unassigned', reviewerMemberId: 'mm' },
      'unassigned',
    );
    check(
      'creation without assignment requires only task:create',
      unassigned.task.status === 'unassigned',
    );
    await rejects(
      'review-required task needs explicit eligible reviewer',
      () =>
        tasks.create('manager', 'b', { title: 'Missing reviewer' }, 'missing'),
      400,
    );
    await rejects(
      'self reviewer rejected',
      () => create('Self', { assigneeMemberId: 'mm', employeeId: undefined }),
      400,
    );
    await rejects(
      'cross-business assignment rejected',
      () =>
        create('Foreign', { assigneeMemberId: 'mo', employeeId: undefined }),
      400,
    );
    await rejects(
      'unconnected employee rejected',
      () => create('Unconnected', { employeeId: 'unconnected' }),
      400,
    );
    await rejects(
      'no-review creation requires task:review',
      () =>
        tasks.create(
          'creator',
          'b',
          { title: 'No review', requiresReview: false },
          'no-review-denied',
        ),
      403,
    );
    const picker = await read.assignees(
      'assigner',
      'b',
      new AssigneeQueryDto(),
    );
    check(
      'assigner picker works without members:view or employees:view',
      picker.items.some((i) => i.employeeId === 'ea'),
    );
    const first = await create('Review work');
    let t = first.task;
    await rejects(
      'outsider cannot read scoped task',
      () => read.detail('outsider', 'b', t.id),
      404,
    );
    const feed = await read.list('bob', undefined, new TaskQueryDto(), true);
    check(
      'unassigned worker sees no unrelated tasks',
      feed.items.length === 0 && feed.summary?.visibleCount === 0,
    );
    await rejects(
      'empty evidence rejected',
      () =>
        tasks.mutate(
          'alice',
          'b',
          t.id,
          'submit',
          { revision: t.revision },
          'empty',
        ),
      400,
    );
    let submitted = await tasks.mutate(
      'alice',
      'b',
      t.id,
      'submit',
      { revision: t.revision, notes: 'Completed the work' },
      'submit-1',
    );
    t = submitted.task;
    check(
      'notes-only submission enters review',
      t.status === 'in_review' && submitted.attempt?.status === 'submitted',
    );
    const replay = await tasks.mutate(
      'alice',
      'b',
      t.id,
      'submit',
      { revision: 1, notes: 'Completed the work' },
      'submit-1',
    );
    check(
      'retry key does not duplicate attempts',
      replay.attempt?.id === submitted.attempt?.id &&
        (await prisma.taskAttempt.count({ where: { taskId: t.id } })) === 1,
    );
    await rejects(
      'same retry key different evidence conflicts',
      () =>
        tasks.mutate(
          'alice',
          'b',
          t.id,
          'submit',
          { revision: 1, notes: 'Different' },
          'submit-1',
        ),
      409,
    );
    await rejects(
      'stale revision rejected',
      () =>
        tasks.mutate('manager', 'b', t.id, 'patch', {
          revision: 1,
          title: 'Lost edit',
        }),
      409,
    );
    let reviewed = await tasks.mutate(
      'manager',
      'b',
      t.id,
      'review',
      {
        revision: t.revision,
        decision: 'request_changes',
        reason: 'Please improve',
      },
      undefined,
      submitted.attempt!.id,
    );
    t = reviewed.task;
    submitted = await tasks.mutate(
      'alice',
      'b',
      t.id,
      'submit',
      {
        revision: t.revision,
        links: [{ url: 'https://example.invalid/proof' }],
      },
      'submit-2',
    );
    t = submitted.task;
    check(
      'redo preserves first rejected evidence',
      (await prisma.taskAttempt.count({ where: { taskId: t.id } })) === 2 &&
        submitted.attempt?.attemptNumber === 2,
    );
    reviewed = await tasks.mutate(
      'manager',
      'b',
      t.id,
      'review',
      { revision: t.revision, decision: 'fail', reason: 'Work failed' },
      undefined,
      submitted.attempt!.id,
    );
    t = reviewed.task;
    check(
      'failed is explicit outcome',
      t.status === 'failed' && reviewed.attempt?.status === 'failed',
    );
    const reassigned = await tasks.mutate('manager', 'b', t.id, 'assign', {
      revision: t.revision,
      assigneeMemberId: 'mb',
      reason: 'Give to Bob',
    });
    t = reassigned.task;
    check(
      'reassignment retains failed attempt and Alice interval',
      (await prisma.taskAttempt.count({
        where: { taskId: t.id, status: 'failed', memberId: 'ma' },
      })) === 1 &&
        (await prisma.taskAssignment.count({ where: { taskId: t.id } })) === 2,
    );
    submitted = await tasks.mutate(
      'bob',
      'b',
      t.id,
      'submit',
      { revision: t.revision, notes: 'Bob completed' },
      'bob-submit',
    );
    t = submitted.task;
    reviewed = await tasks.mutate(
      'manager',
      'b',
      t.id,
      'review',
      { revision: t.revision, decision: 'accept' },
      undefined,
      submitted.attempt!.id,
    );
    t = reviewed.task;
    check(
      'review acceptance completes current assignment',
      t.status === 'completed',
    );
    const reopened = await tasks.mutate('manager', 'b', t.id, 'reopen', {
      revision: t.revision,
      reason: 'Redo with new requirements',
    });
    t = reopened.task;
    check(
      'reopen creates separate cycle and preserves accepted attempt',
      t.status === 'todo' &&
        (await prisma.taskAssignment.count({ where: { taskId: t.id } })) ===
          3 &&
        (await prisma.taskAttempt.count({
          where: { taskId: t.id, status: 'accepted' },
        })) === 1,
    );
    await tasks.mutate('manager', 'b', t.id, 'cancel', {
      revision: t.revision,
      reason: 'No longer needed',
    });
    const report = await analytics.report(
      'manager',
      'b',
      new AnalyticsQueryDto(),
    );
    const alice = report.items.find((i) => i.id === 'ma')!,
      bob = report.items.find((i) => i.id === 'mb')!;
    check(
      'analytics failure stays attributed to original assignee',
      alice.failedAttemptCount === 1 && bob.failedAttemptCount === 0,
    );
    check(
      'analytics reassignment completion does not credit Alice',
      alice.completionRate.value === 0 && bob.completionRate.value === 1,
    );
    check(
      'analytics redo and cancellation denominators explicit',
      alice.redoAttemptCount === 1 &&
        bob.excludedCancelledCount === 1 &&
        report.totals.reopenedTaskCount === 1,
    );
    await rejects(
      'worker cannot view business analytics',
      () => analytics.report('alice', 'b', new AnalyticsQueryDto()),
      403,
    );
    check(
      'own analytics available without report grant',
      (
        await analytics.report(
          'alice',
          'b',
          Object.assign(new AnalyticsQueryDto(), { scope: 'me' }),
        )
      ).items.every((i) => i.id === 'ma'),
    );
    const auto = await create('Automatic', {
      requiresReview: false,
      reviewerMemberId: null,
    });
    const autoResult = await tasks.mutate(
      'alice',
      'b',
      auto.task.id,
      'submit',
      { revision: auto.task.revision, notes: 'Done' },
      'auto',
    );
    check(
      'no-review submission atomically accepts',
      autoResult.task.status === 'completed' &&
        autoResult.attempt?.status === 'accepted',
    );
    const pending = await create('Pending reassignment');
    const pendingSubmission = await tasks.mutate(
      'alice',
      'b',
      pending.task.id,
      'submit',
      { revision: pending.task.revision, notes: 'Pending' },
      'pending',
    );
    const changed = await tasks.mutate(
      'manager',
      'b',
      pending.task.id,
      'assign',
      {
        revision: pendingSubmission.task.revision,
        assigneeMemberId: 'mb',
        reason: 'Changed owner',
      },
    );
    await rejects(
      'superseded pending review cannot later be accepted',
      () =>
        tasks.mutate(
          'manager',
          'b',
          pending.task.id,
          'review',
          { revision: changed.task.revision, decision: 'accept' },
          undefined,
          pendingSubmission.attempt!.id,
        ),
      409,
    );
    check(
      'superseded attempt remains distinguishable',
      (
        await prisma.taskAttempt.findUniqueOrThrow({
          where: { id: pendingSubmission.attempt!.id },
        })
      ).status === 'superseded',
    );
    const concurrent = await create('Concurrent');
    const outcomes = await Promise.allSettled([
      tasks.mutate('manager', 'b', concurrent.task.id, 'patch', {
        revision: 1,
        title: 'A',
      }),
      tasks.mutate('manager', 'b', concurrent.task.id, 'patch', {
        revision: 1,
        title: 'B',
      }),
    ]);
    check(
      'concurrent writes allow exactly one revision winner',
      outcomes.filter((o) => o.status === 'fulfilled').length === 1,
    );
    await prisma.roleDeniedPermission.create({
      data: { roleId: 'management', permission: 'task:create' },
    });
    await rejects(
      'explicit denial overrides management grant',
      () => create('Denied management'),
      403,
    );
    await prisma.roleDeniedPermission.delete({
      where: {
        roleId_permission: { roleId: 'management', permission: 'task:create' },
      },
    });
    const evidenceTask = await create('Image work');
    await rejects(
      'oversized image rejected',
      () =>
        images.intent('alice', 'b', evidenceTask.task.id, {
          name: 'big.png',
          contentType: 'image/png',
          sizeBytes: 6000000,
        }),
      413,
    );
    await rejects(
      'unsupported image rejected',
      () =>
        images.intent('alice', 'b', evidenceTask.task.id, {
          name: 'bad.svg',
          contentType: 'image/svg+xml',
          sizeBytes: 100,
        }),
      415,
    );
    const intent = await images.intent('alice', 'b', evidenceTask.task.id, {
      name: 'proof.png',
      contentType: 'image/png',
      sizeBytes: 100,
    });
    check(
      'intent uses authenticated signed Cloudinary upload',
      intent.fields.type === 'authenticated' && !!intent.fields.signature,
    );
    const original = cloudinary.api.resource;
    cloudinary.api.resource = async () =>
      ({
        public_id: intent.fields.public_id,
        type: 'authenticated',
        resource_type: 'image',
        bytes: 100,
        width: 10,
        height: 10,
        format: 'png',
        version: 1,
      }) as never;
    try {
      await rejects(
        'another user cannot finalize draft',
        () => images.finalize('bob', 'b', evidenceTask.task.id, intent.imageId),
        404,
      );
      const finalized = await images.finalize(
        'alice',
        'b',
        evidenceTask.task.id,
        intent.imageId,
      );
      check(
        'provider resource verifies finalized image',
        finalized.image.width === 10 &&
          finalized.image.url.includes('/content?token='),
      );
      const result = await tasks.mutate(
        'alice',
        'b',
        evidenceTask.task.id,
        'submit',
        { revision: 1, imageIds: [intent.imageId] },
        'image-submit',
      );
      check(
        'image-only evidence accepted',
        result.attempt?.evidence.images.length === 1,
      );
      await rejects(
        'submitted image cannot be deleted',
        () => images.remove('alice', 'b', evidenceTask.task.id, intent.imageId),
        400,
      );
    } finally {
      cloudinary.api.resource = original;
    }
    const refreshedDraft = await prisma.taskImage.create({
      data: {
        taskId: evidenceTask.task.id,
        uploadedByUserId: 'alice',
        publicId: 'cleanup-race-test',
        name: 'race.png',
        contentType: 'image/png',
        sizeBytes: 100,
        expiresAt: new Date(Date.now() - 60000),
      },
    });
    const originalDestroy = cloudinary.uploader.destroy;
    let deletedBlobs = 0;
    cloudinary.uploader.destroy = async () => {
      deletedBlobs++;
      return { result: 'ok' };
    };
    // Finalization commits after cleanup has selected an expired intent but
    // before it acquires the task lock. Execute the deletion guard in PostgreSQL.
    const cleanupDb = new Proxy(db, {
      get(target, property) {
        if (property === 'taskImage')
          return {
            findMany: async () => {
              await prisma!.taskImage.update({
                where: { id: refreshedDraft.id },
                data: {
                  status: 'finalized',
                  expiresAt: new Date(Date.now() + 86400000),
                },
              });
              return [refreshedDraft];
            },
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      await new TaskImagesService(cleanupDb, access, config).cleanup();
      check(
        'cleanup preserves a concurrently finalized draft',
        deletedBlobs === 0 &&
          (
            await prisma.taskImage.findUniqueOrThrow({
              where: { id: refreshedDraft.id },
            })
          ).status === 'finalized',
      );
    } finally {
      cloudinary.uploader.destroy = originalDestroy;
    }
    const overdue = await create('Overdue', {
      dueAt: new Date(Date.now() - 60000).toISOString(),
    });
    await reminders.reconcile();
    await reminders.reconcile();
    check(
      'scheduled overdue notification deduplicated',
      (await prisma.userNotification.count({
        where: {
          type: 'task_overdue',
          data: { path: ['taskId'], equals: overdue.task.id },
        },
      })) === 1,
    );
    const page = await read.list(
      'manager',
      'b',
      Object.assign(new TaskQueryDto(), { limit: 1 }),
      true,
    );
    check(
      'dashboard totals cover more than loaded page',
      page.items.length === 1 && page.summary!.visibleCount > 1,
    );
    await rejects(
      'cursor cannot be reused with changed filters',
      () =>
        read.list(
          'manager',
          'b',
          Object.assign(new TaskQueryDto(), {
            limit: 1,
            status: 'todo',
            cursor: page.nextCursor,
          }),
          true,
        ),
      400,
    );
    await prisma.businessEmployee.update({
      where: { id: 'ea' },
      data: { status: 'archived' },
    });
    await rejects(
      'archived linked employee blocks task actions',
      () =>
        tasks.mutate('alice', 'b', overdue.task.id, 'start', {
          revision: overdue.task.revision,
        }),
      400,
    );
    check(
      'history survives employee archival',
      (await read.detail('manager', 'b', overdue.task.id)).task.assignee !==
        null,
    );
    const contact = {
      kind: 'demo',
      name: 'Ada',
      email: 'ada@example.invalid',
      businessName: 'Shop',
      locations: '2 stores',
      planInterest: 'unsure',
      focus: 'Inventory logs',
      message: 'Hello',
    };
    const received = await contacts.receive('192.0.2.1', contact, 'request-1');
    const repeated = await contacts.receive('192.0.2.1', contact, 'request-1');
    check(
      'contact persisted with all frontend fields and retry deduplicated',
      received.requestId === repeated.requestId &&
        (await prisma.contactRequest.count()) === 1,
    );
    await rejects(
      'contact retry key cannot change request',
      () =>
        contacts.receive(
          '192.0.2.1',
          { ...contact, message: 'Changed' },
          'request-1',
        ),
      409,
    );
    for (let n = 0; n < 2; n++)
      await contacts.receive('192.0.2.1', {
        ...contact,
        message: `Different ${n}`,
      });
    await rejects(
      'normalized email rate bucket limits distinct requests',
      () => contacts.receive('192.0.2.2', { ...contact, message: 'Fourth' }),
      429,
    );
    await rejects(
      'honeypot rejected without fake received response',
      () =>
        contacts.receive('192.0.2.3', {
          ...contact,
          email: 'bot@example.invalid',
          website: 'filled',
        }),
      400,
    );
    await rejects('SQL blocks mutation of submitted evidence', () =>
      pool.query('UPDATE "TaskAttempt" SET "evidence"=\'{}\' WHERE "id"=$1', [
        pendingSubmission.attempt!.id,
      ]),
    );
    await rejects('SQL blocks deletion of task history', () =>
      pool.query('DELETE FROM "TaskEntry" WHERE "taskId"=$1', [
        overdue.task.id,
      ]),
    );
    check(
      'task audit and notifications durable',
      (await prisma.auditEvent.count({
        where: { eventType: { startsWith: 'business.task.' } },
      })) > 10 &&
        (await prisma.userNotification.count({
          where: { type: 'task_assigned' },
        })) > 0,
    );
    const reviewerPicker = await read.reviewers(
      'creator',
      'b',
      new ReviewerQueryDto(),
    );
    check(
      'creation-only role can select eligible reviewers without member-list permission',
      reviewerPicker.items.some((m) => m.memberId === 'mm'),
    );
    await prisma.roleDeniedPermission.create({
      data: { roleId: 'management', permission: 'task:review' },
    });
    check(
      'reviewer picker honors explicit review denial',
      (await read.reviewers('creator', 'b', new ReviewerQueryDto())).items
        .length === 0,
    );
    await prisma.roleDeniedPermission.delete({
      where: {
        roleId_permission: { roleId: 'management', permission: 'task:review' },
      },
    });
    const future = await analytics.report(
      'manager',
      'b',
      Object.assign(new AnalyticsQueryDto(), {
        from: new Date(Date.now() + 60000).toISOString(),
        to: new Date(Date.now() + 120000).toISOString(),
      }),
    );
    check(
      'empty analytics periods have null rates and averages',
      future.totals.completionRate.value === null &&
        future.totals.averageCompletionSeconds.value === null,
    );
    const firstAssignment = await prisma.taskAssignment.findFirstOrThrow({
      where: { taskId: first.task.id, memberId: 'ma' },
      orderBy: { cycle: 'asc' },
    });
    const boundary = await analytics.report(
      'manager',
      'b',
      Object.assign(new AnalyticsQueryDto(), {
        memberId: 'ma',
        from: firstAssignment.assignedAt.toISOString(),
        to: new Date(firstAssignment.assignedAt.getTime() + 1).toISOString(),
      }),
    );
    check(
      'analytics uses inclusive from and exclusive to boundaries',
      boundary.totals.assignmentCount === 1,
    );
    const notOverdue = await read.list(
      'manager',
      'b',
      Object.assign(new TaskQueryDto(), { overdue: 'false' }),
    );
    check(
      'non-overdue filter includes tasks without deadlines',
      notOverdue.items.some((i) => i.dueAt === null),
    );
    const completedEmployee = await read.list(
      'manager',
      'b',
      Object.assign(new TaskQueryDto(), {
        employeeId: 'ea',
        status: 'completed',
      }),
    );
    check(
      'employee filter includes completed current assignments',
      completedEmployee.items.some((i) => i.id === auto.task.id),
    );
    await prisma.role.create({
      data: {
        id: 'management_other',
        businessId: 'other',
        key: 'management',
        name: 'Management',
        type: 'custom',
        permissions: {
          create: [
            'task:create',
            'task:assign',
            'task:view',
            'task:update',
            'task:review',
            'task:report',
          ].map((permission) => ({ permission })),
        },
      },
    });
    await prisma.businessMember.create({
      data: {
        id: 'mm_other',
        userId: 'manager',
        businessId: 'other',
        roleId: 'management_other',
      },
    });
    await tasks.create(
      'manager',
      'other',
      {
        title: 'Other company task',
        requiresReview: false,
        assigneeMemberId: 'mm_other',
      },
      'other-company',
    );
    const crossBusiness = await read.list(
      'manager',
      undefined,
      new TaskQueryDto(),
      true,
    );
    check(
      'dashboard includes authorized tasks and identities across businesses',
      crossBusiness.summary!.businessCount === 2 &&
        crossBusiness.items.some((i) => i.business.id === 'other'),
    );
    check(
      'dashboard does not reveal other members tasks or business counts',
      (await read.list('outsider', undefined, new TaskQueryDto(), true))
        .summary!.visibleCount === 0,
    );
    await prisma.user.create({
      data: {
        id: 'nomember',
        email: 'nomember@example.invalid',
        name: 'No member',
        emailVerifiedAt: new Date(),
      },
    });
    check(
      'account with no memberships has a valid empty dashboard',
      (await read.list('nomember', undefined, new TaskQueryDto(), true)).items
        .length === 0,
    );
    const countBefore = await prisma.businessTask.count({
        where: { businessId: 'b' },
      }),
      notificationsBefore = await prisma.userNotification.count({
        where: { type: 'task_assigned' },
      });
    await rejects(
      'invalid assignment transaction rolls back task creation',
      () =>
        create('Rollback', {
          assigneeMemberId: 'missing',
          employeeId: undefined,
        }),
      400,
    );
    check(
      'rollback leaves no task or notification behind',
      (await prisma.businessTask.count({ where: { businessId: 'b' } })) ===
        countBefore &&
        (await prisma.userNotification.count({
          where: { type: 'task_assigned' },
        })) === notificationsBefore,
    );
    await prisma.user.update({
      where: { id: 'alice' },
      data: { name: 'Renamed Alice' },
    });
    check(
      'history retains original actor name after account rename',
      (
        await prisma.taskEntry.findFirstOrThrow({
          where: { taskId: first.task.id, event: 'submitted' },
        })
      ).actor !== null &&
        JSON.stringify(
          (
            await prisma.taskEntry.findFirstOrThrow({
              where: { taskId: first.task.id, event: 'submitted' },
            })
          ).actor,
        ).includes('alice'),
    );
    await prisma.businessMember.update({
      where: { id: 'ma' },
      data: {
        status: 'suspended',
        statusUpdatedByUserId: 'manager',
        statusUpdatedAt: new Date(),
      },
    });
    await rejects(
      'suspended membership blocks task reads',
      () => read.detail('alice', 'b', first.task.id),
      403,
    );
    await prisma.user.update({
      where: { id: 'bob' },
      data: { status: 'suspended' },
    });
    await rejects(
      'inactive account blocks dashboard feed',
      () => read.list('bob', undefined, new TaskQueryDto(), true),
      401,
    );
    await prisma.business.update({
      where: { id: 'b' },
      data: { status: 'suspended' },
    });
    await rejects(
      'inactive business blocks task reads',
      () => read.detail('manager', 'b', first.task.id),
      403,
    );
    for (let n = 0; n < 5; n++)
      await contacts.receive('192.0.2.10', {
        ...contact,
        email: `ip${n}@example.invalid`,
        message: `IP ${n}`,
      });
    await rejects(
      'IP 15-minute limit is shared across distinct emails',
      () =>
        contacts.receive('192.0.2.10', {
          ...contact,
          email: 'ipnext@example.invalid',
        }),
      429,
    );
    const dayKey = createHmac('sha256', 'isolated-test-pepper')
      .update(`ip:192.0.2.11:86400000:${Math.floor(Date.now() / 86400000)}`)
      .digest('hex');
    await prisma.contactRateBucket.create({
      data: {
        key: dayKey,
        count: 20,
        expiresAt: new Date((Math.floor(Date.now() / 86400000) + 1) * 86400000),
      },
    });
    await rejects(
      'IP daily limit enforced independently',
      () =>
        contacts.receive('192.0.2.11', {
          ...contact,
          email: 'daily@example.invalid',
        }),
      429,
    );
    await prisma.$transaction(seedSystemRoles, { timeout: 90000 });
    check(
      'owner/admin receive all six protected task grants',
      (await prisma.rolePermission.count({
        where: {
          roleId: { in: ['system-role-owner', 'system-role-admin'] },
          permission: { startsWith: 'task:' },
        },
      })) === 12,
    );
    await rejects('system employee role cannot gain task management', () =>
      prisma!.rolePermission.create({
        data: { roleId: 'system-role-employee', permission: 'task:assign' },
      }),
    );
    console.log(`${passed} task/contact database checks passed.`);
  } finally {
    await prisma?.$disconnect();
    await pool.end();
    if (created) {
      assert.match(schema, /^tasks_test_[a-f0-9]{16}$/);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await admin.end();
  }
}
main().catch((e) => {
  console.error(databaseErrorSummary(e));
  process.exitCode = 1;
});
