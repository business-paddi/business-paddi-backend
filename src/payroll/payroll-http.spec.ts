import { Test } from '@nestjs/testing';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import { PayrollController } from './payroll.controller';
import { PayrollReadService } from './payroll-read.service';
import { PayrollService } from './payroll.service';
describe('Payroll HTTP contracts', () => {
  let app: INestApplication<Server>;
  const payroll = {
    create: jest.fn(() => ({ batch: { id: 'b', status: 'draft' } })),
    mutate: jest.fn(() => ({ batch: { id: 'b', status: 'draft' } })),
  };
  const read = {
    list: jest.fn(() => ({
      items: [],
      nextCursor: null,
      summary: {
        draftCount: 0,
        submittedCount: 0,
        changesRequestedCount: 0,
        approvedCount: 0,
      },
    })),
    detail: jest.fn(),
    recipients: jest.fn(),
    candidates: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PayrollController],
      providers: [
        { provide: PayrollService, useValue: payroll },
        { provide: PayrollReadService, useValue: read },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate(ctx: {
          switchToHttp: () => {
            getRequest: () => {
              headers: Record<string, string>;
              auth?: { userId: string };
            };
          };
        }) {
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
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());
  const path = '/api/businesses/business/payroll';
  const draft = {
    name: 'October',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    payDate: '2026-10-31',
    payFrequency: 'monthly',
    currency: 'NGN',
    employeeIds: ['e'],
  };
  it('requires authentication and disables response caching', async () => {
    await request(app.getHttpServer()).get(`${path}/batches`).expect(401);
    const response = await request(app.getHttpServer())
      .get(`${path}/batches`)
      .set('x-test-user', 'u')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(read.list).toHaveBeenCalledWith(
      'u',
      'business',
      expect.objectContaining({ limit: 25 }),
    );
  });
  it('rejects actor spoofing and duplicate employee IDs before persistence', async () => {
    for (const fields of [
      { createdBy: 'attacker' },
      { employeeIds: ['e', 'e'] },
      { currency: 'USD' },
      { name: null },
    ])
      await request(app.getHttpServer())
        .post(`${path}/batches`)
        .set('x-test-user', 'u')
        .send({ ...draft, ...fields })
        .expect(400);
    expect(payroll.create).not.toHaveBeenCalled();
  });
  it('passes the authenticated actor and request key to draft creation', async () => {
    await request(app.getHttpServer())
      .post(`${path}/batches`)
      .set('x-test-user', 'u')
      .set('Idempotency-Key', 'create-key')
      .send(draft)
      .expect(201);
    expect(payroll.create).toHaveBeenCalledWith(
      'u',
      'business',
      expect.objectContaining(draft),
      'create-key',
    );
  });
  it('requires revision and rejects floating-point or negative money', async () => {
    for (const fields of [
      { baseAmount: 10.5 },
      { baseAmount: '-1.00' },
      { baseAmount: '1.234' },
      { expectedRevision: 0 },
      { baseAmount: null },
    ])
      await request(app.getHttpServer())
        .patch(`${path}/batches/b/recipients/r`)
        .set('x-test-user', 'u')
        .send({ expectedRevision: 1, ...fields })
        .expect(400);
    expect(payroll.mutate).not.toHaveBeenCalled();
  });
  it('accepts an intentional empty adjustment replacement but rejects client statutory edits', async () => {
    await request(app.getHttpServer())
      .patch(`${path}/batches/b/recipients/r`)
      .set('x-test-user', 'u')
      .send({ expectedRevision: 1, adjustments: [] })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`${path}/batches/b/recipients/r`)
      .set('x-test-user', 'u')
      .send({ expectedRevision: 1, statutoryLines: [] })
      .expect(400);
  });
  it('limits pages and validates review decisions and refresh identities', async () => {
    await request(app.getHttpServer())
      .get(`${path}/batches?limit=101`)
      .set('x-test-user', 'u')
      .expect(400);
    await request(app.getHttpServer())
      .post(`${path}/batches/b/review`)
      .set('x-test-user', 'u')
      .send({ expectedRevision: 1, decision: 'pay' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`${path}/batches/b/refresh`)
      .set('x-test-user', 'u')
      .send({ expectedRevision: 1, recipientIds: [] })
      .expect(400);
  });
});
