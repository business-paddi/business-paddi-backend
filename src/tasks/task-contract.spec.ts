import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import { DashboardTaskController, TaskController } from './task.controller';
import { TaskService } from './task.service';
import { TaskReadService } from './task-read.service';
import { TaskImagesService } from './task-images.service';
import { TaskAnalyticsService } from './task-analytics.service';
import { decodeCursor, encodeCursor, digest } from './task.utils';
import { ratio } from './task-analytics.service';
import type { PrismaService } from '../database/prisma.service';
import type { TaskAccessService } from './task-access.service';
import type { TaskOperationService } from './task-operation.service';
import { TaskQueryDto } from './task.dto';
describe('Task HTTP and cursor contracts', () => {
  let app: INestApplication<Server>;
  const tasks = {
    create: jest.fn(() => ({ task: { id: 't', revision: 1 } })),
    mutate: jest.fn(() => ({ task: { id: 't', revision: 2 } })),
  };
  const read = {
    list: jest.fn(() => ({
      items: [],
      nextCursor: null,
      summary: { visibleCount: 0 },
    })),
    detail: jest.fn(),
    collection: jest.fn(),
    assignees: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TaskController, DashboardTaskController],
      providers: [
        { provide: TaskService, useValue: tasks },
        { provide: TaskReadService, useValue: read },
        { provide: TaskImagesService, useValue: {} },
        { provide: TaskAnalyticsService, useValue: {} },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => {
            getRequest: () => {
              headers: Record<string, string>;
              auth?: { userId: string };
            };
          };
        }) => {
          const r = ctx.switchToHttp().getRequest();
          if (!r.headers['x-test-user']) throw new UnauthorizedException();
          r.auth = { userId: r.headers['x-test-user'] };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());
  it('requires authentication for task and dashboard reads', async () => {
    await request(app.getHttpServer()).get('/api/dashboard/tasks').expect(401);
    await request(app.getHttpServer())
      .get('/api/businesses/b/tasks')
      .expect(401);
  });
  it('dashboard default page is ten and scope is visible', async () => {
    await request(app.getHttpServer())
      .get('/api/dashboard/tasks')
      .set('x-test-user', 'u')
      .expect(200);
    expect(read.list).toHaveBeenCalledWith(
      'u',
      undefined,
      expect.objectContaining({
        limit: 10,
        scope: 'visible',
        sort: 'updatedAt_desc',
      }),
      true,
    );
  });
  it('accepts custom text without arbitrary status mutation', async () => {
    await request(app.getHttpServer())
      .patch('/api/businesses/b/tasks/t')
      .set('x-test-user', 'u')
      .send({ revision: 1, status: 'completed' })
      .expect(400);
    expect(tasks.mutate).not.toHaveBeenCalled();
  });
  it('rejects executable evidence links', async () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/plain,proof',
      'file:///etc/passwd',
    ])
      await request(app.getHttpServer())
        .post('/api/businesses/b/tasks/t/submissions')
        .set('x-test-user', 'u')
        .set('Idempotency-Key', 'k')
        .send({ revision: 1, links: [{ url }] })
        .expect(400);
    expect(tasks.mutate).not.toHaveBeenCalled();
  });
  it('accepts notes-only and links-only submissions with retry key', async () => {
    for (const evidence of [
      { notes: 'Completed' },
      { links: [{ url: 'https://example.test/proof' }] },
    ])
      await request(app.getHttpServer())
        .post('/api/businesses/b/tasks/t/submissions')
        .set('x-test-user', 'u')
        .set('Idempotency-Key', 'k')
        .send({ revision: 1, ...evidence })
        .expect(200);
    expect(tasks.mutate).toHaveBeenCalledTimes(2);
  });
  it('requires comment revisions and does not accept arbitrary payload fields', async () => {
    await request(app.getHttpServer())
      .post('/api/businesses/b/tasks/t/comments')
      .set('x-test-user', 'u')
      .send({ notes: 'Hello' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/businesses/b/tasks/t/comments')
      .set('x-test-user', 'u')
      .set('Idempotency-Key', 'comment')
      .send({ revision: 1, notes: 'Hello' })
      .expect(201);
  });
  it('rejects null nonnullable fields and excessive input', async () => {
    for (const extra of [
      { priority: null },
      { requiresReview: null },
      { title: 'x'.repeat(201) },
    ])
      await request(app.getHttpServer())
        .post('/api/businesses/b/tasks')
        .set('x-test-user', 'u')
        .set('Idempotency-Key', 'create')
        .send({ title: 'Task', ...extra })
        .expect(400);
  });
  it('rejects invalid filter values and bounds', async () => {
    for (const query of [
      'limit=101',
      'overdue=yes',
      'sort=title',
      'status=overdue',
    ])
      await request(app.getHttpServer())
        .get(`/api/businesses/b/tasks?${query}`)
        .set('x-test-user', 'u')
        .expect(400);
  });
  it('binds cursors to actor and filters and detects tampering', () => {
    const filter = { user: 'u', status: 'todo' },
      cursor = encodeCursor('secret', filter, { id: 't' });
    expect(decodeCursor('secret', filter, cursor)).toEqual({ id: 't' });
    expect(() =>
      decodeCursor('secret', { ...filter, user: 'v' }, cursor),
    ).toThrow();
    expect(() => decodeCursor('secret', filter, `${cursor}x`)).toThrow();
  });
  it('idempotency hashing ignores object property order', () => {
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });
  it('rates distinguish no data from zero completion', () => {
    expect(ratio(0, 0).value).toBeNull();
    expect(ratio(0, 2).value).toBe(0);
    expect(ratio(1, 2).value).toBe(0.5);
  });
  it('no memberships returns zero counts without querying unrelated tasks', async () => {
    const findMany = jest.fn();
    const service = new TaskReadService(
      { businessTask: { findMany } } as unknown as PrismaService,
      {} as TaskAccessService,
      { secret: 'test' } as TaskOperationService,
      {} as TaskImagesService,
    );
    jest.spyOn(service, 'contexts').mockResolvedValue([]);
    const result = await service.list('u', undefined, new TaskQueryDto(), true);
    expect(result.items).toEqual([]);
    expect(result.summary?.visibleCount).toBe(0);
    expect(result.summary?.businessCount).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
