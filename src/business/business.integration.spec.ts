import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import {
  BusinessController,
  BusinessInviteController,
} from './business.controller';
import { BusinessService } from './business.service';
import { EmployeeService } from './employee.service';
import { InviteService } from './invite.service';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import { BusinessAccessService } from './business-access.service';
import { PrismaService } from '../database/prisma.service';
import {
  allowedPermissions,
  systemRolePermissions,
} from '../business-foundation/permission-catalog';
import { EmailService } from '../email/email.service';
import { createHash, randomBytes } from 'node:crypto';
import type { EmployeeDto, OnboardDto } from './business.dto';
import type { Server } from 'node:http';

describe('Business HTTP contracts', () => {
  let app: INestApplication<Server>;
  const employees = {
    create: jest.fn((_u: string, id: string, body: EmployeeDto) => ({
      employee: {
        id: 'employee-1',
        businessId: id,
        ...body,
        amount: null,
        paymentStatus: 'blocked',
      },
    })),
    update: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    archive: jest.fn(),
    tax: jest.fn(),
    putTax: jest.fn(),
  };
  const businesses = {
    onboard: jest.fn((_u: string, body: OnboardDto) => body),
    create: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
  };
  const invites = { accept: jest.fn(), create: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BusinessController, BusinessInviteController],
      providers: [
        { provide: BusinessService, useValue: businesses },
        { provide: EmployeeService, useValue: employees },
        { provide: InviteService, useValue: invites },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => {
            getRequest: () => { auth?: { userId: string } };
          };
        }) => {
          context.switchToHttp().getRequest().auth = { userId: 'current-user' };
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
  afterAll(async () => {
    await app.close();
  });
  const valid = {
    fullName: '  Ada Okafor  ',
    email: ' ADA@EXAMPLE.COM ',
    state: 'Lagos',
    employeeTypeId: 'type-1',
  };
  it('registers with four fields, normalized email and no compensation or bank', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/businesses/business-1/employees')
      .send(valid)
      .expect(201);
    expect(response.body).toEqual({
      employee: {
        ...valid,
        fullName: 'Ada Okafor',
        email: 'ada@example.com',
        id: 'employee-1',
        businessId: 'business-1',
        amount: null,
        paymentStatus: 'blocked',
      },
    });
    expect(employees.create).toHaveBeenLastCalledWith(
      'current-user',
      'business-1',
      expect.objectContaining({ email: 'ada@example.com' }),
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each([
    { email: 'bad' },
    { state: 'London' },
    { employeeTypeId: null },
    { fullName: '   ' },
    { amount: '-1' },
    { businessId: 'other' },
  ])('rejects invalid registration and unknown fields %j', async (change) => {
    await request(app.getHttpServer())
      .post('/api/businesses/b/employees')
      .send({ ...valid, ...change })
      .expect(400);
  });
  it('rejects missing business and invalid nested onboarding employees', async () => {
    await request(app.getHttpServer())
      .post('/api/businesses/onboard')
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/businesses/onboard')
      .send({
        business: { name: 'Acme' },
        employees: [{ ...valid, employeeTypeKey: 'full_time' }],
      })
      .expect(400);
  });
  it('accepts optional compensation at creation without making it mandatory', async () => {
    await request(app.getHttpServer())
      .post('/api/businesses/b/employees')
      .send({ ...valid, amount: '0.00', jobTitle: 'Engineer' })
      .expect(201);
    expect(employees.create).toHaveBeenLastCalledWith(
      'current-user',
      'b',
      expect.objectContaining({ amount: '0.00', jobTitle: 'Engineer' }),
    );
  });
  it('accepts transactional onboarding type keys and optional connection intent', async () => {
    await request(app.getHttpServer())
      .post('/api/businesses/onboard')
      .send({
        business: { name: 'Acme' },
        employees: [
          {
            fullName: 'Ada',
            email: 'ada@example.com',
            state: 'Lagos',
            employeeTypeKey: 'full_time',
            connectToPlatform: true,
          },
        ],
      })
      .expect(201);
  });
  it.each([
    { accountVerificationStatus: 'verified' },
    { totalAmountPaid: '1000' },
    { businessMemberId: 'm' },
    { amount: '-1' },
    { amount: '1.123' },
    { email: null },
    { payFrequency: null },
    { groupIds: ['g', 'g'] },
  ])('rejects authoritative/invalid updates %j', async (body) => {
    await request(app.getHttpServer())
      .patch('/api/businesses/b/employees/e')
      .send(body)
      .expect(400);
  });
  it('rejects invalid dates, rates and plaintext arbitrary tax JSON', async () => {
    await request(app.getHttpServer())
      .put('/api/businesses/b/employees/e/tax-profile')
      .send({ employmentStartDate: '2026-02-30' })
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/businesses/b/employees/e/tax-profile')
      .send({ pensionContributionRate: '101' })
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/businesses/b/employees/e/tax-profile')
      .send({ additionalTaxInformation: { tin: '123' } })
      .expect(400);
  });
  it('rejects malformed invitation tokens before calling service', async () => {
    await request(app.getHttpServer())
      .post('/api/business-invites/accept')
      .send({ token: 'bad' })
      .expect(400);
  });
  it('has no ownership-transfer route or writable owner field', async () => {
    await request(app.getHttpServer())
      .patch('/api/businesses/b')
      .send({ ownerId: 'other-user' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/businesses/b/transfer-owner')
      .send({ userId: 'other-user' })
      .expect(404);
    expect(businesses.update).not.toHaveBeenCalled();
  });
});

describe('Business authorization', () => {
  const findUnique = jest.fn();
  const access = new BusinessAccessService({
    businessMember: { findUnique },
  } as unknown as PrismaService);
  const membership = (
    key: keyof typeof systemRolePermissions,
    status = 'active',
  ) => ({
    id: 'm',
    status,
    business: { status: 'active' },
    role: {
      type: 'system',
      status: 'active',
      permissions: systemRolePermissions[key].map((permission: string) => ({
        permission,
      })),
      deniedPermissions: [],
    },
  });
  it('hides unrelated business existence', async () => {
    findUnique.mockResolvedValue(null);
    await expect(access.require('u', 'b')).rejects.toMatchObject({
      status: 404,
    });
  });
  it.each(['suspended', 'removed'])('denies %s membership', async (status) => {
    findUnique.mockResolvedValue(membership('owner', status));
    await expect(access.require('u', 'b')).rejects.toMatchObject({
      status: 403,
    });
  });
  it('does not grant administrators owner-only business updates', async () => {
    findUnique.mockResolvedValue(membership('admin'));
    await expect(
      access.require('u', 'b', ['business:update']),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('denials override grants and custom roles cannot cross tenants', async () => {
    findUnique.mockResolvedValue({
      ...membership('owner'),
      role: {
        ...membership('owner').role,
        deniedPermissions: [{ permission: 'employees:view' }],
      },
    });
    await expect(
      access.require('u', 'b', ['employees:view']),
    ).rejects.toMatchObject({ status: 403 });
    findUnique.mockResolvedValue({
      ...membership('owner'),
      role: {
        ...membership('owner').role,
        type: 'custom',
        businessId: 'other',
      },
    });
    await expect(access.require('u', 'b')).rejects.toMatchObject({
      status: 403,
    });
  });
  it('all owner grants remain exactly the catalog', async () => {
    findUnique.mockResolvedValue(membership('owner'));
    expect((await access.require('u', 'b')).permissions).toEqual(
      allowedPermissions,
    );
  });
  it.each(['employee', 'accountant'] as const)(
    'keeps sensitive tax access unavailable to %s',
    async (key) => {
      findUnique.mockResolvedValue(membership(key));
      await expect(
        access.require('u', 'b', ['employees:view', 'employees:update']),
      ).rejects.toMatchObject({ status: 403 });
    },
  );
});

describe('Employee persistence contracts', () => {
  const db = {
    businessEmployee: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    employeeType: { findFirst: jest.fn() },
    employeeTaxProfile: { findUnique: jest.fn(), upsert: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const prisma = {
    ...db,
    $transaction: jest.fn(async (fn: (db: unknown) => Promise<unknown>) =>
      fn(db),
    ),
  } as unknown as PrismaService;
  const access = {
    lock: jest.fn(),
    require: jest.fn(),
  } as unknown as BusinessAccessService;
  const key = randomBytes(32).toString('base64');
  const service = new EmployeeService(
    prisma,
    access,
    new ConfigService({ PAYROLL_ENCRYPTION_KEY: key }),
  );
  const minimal = {
    fullName: 'Ada',
    email: 'ada@example.com',
    state: 'Lagos',
    employeeTypeId: 't',
  };
  const stored = {
    id: 'e',
    businessId: 'b',
    ...minimal,
    amount: null,
    bankCode: null,
    bankName: null,
    accountNumber: null,
    accountName: null,
    status: 'active',
    payFrequency: 'monthly',
    paymentStatus: 'blocked',
  };
  beforeEach(() => {
    jest.clearAllMocks();
    db.businessEmployee.findUnique.mockResolvedValue(stored);
    db.businessEmployee.create.mockResolvedValue(stored);
    db.businessEmployee.update.mockResolvedValue(stored);
    db.employeeType.findFirst.mockResolvedValue({ id: 't' });
    db.employeeTaxProfile.findUnique.mockResolvedValue(null);
  });
  it('creates no membership, bank verification or tax profile and omits amount', async () => {
    await service.create('u', 'b', minimal);
    expect(db.businessEmployee.create).toHaveBeenCalledWith({
      data: {
        ...minimal,
        businessId: 'b',
        paymentBlockedReason: 'missing_compensation_and_bank_details',
      },
    });
    expect(db.employeeTaxProfile.upsert).not.toHaveBeenCalled();
  });
  it('rejects cross-business employee type before persistence', async () => {
    db.employeeType.findFirst.mockResolvedValue(null);
    await expect(service.create('u', 'b', minimal)).rejects.toMatchObject({
      status: 400,
    });
    expect(db.businessEmployee.create).not.toHaveBeenCalled();
  });
  it('encrypts bank identifiers and leaves payment blocked', async () => {
    await service.update('u', 'b', 'e', {
      accountNumber: '0012345678',
      amount: '50.00',
    });
    expect(db.businessEmployee.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountNumber: expect.stringMatching(/^enc:v1:/) as unknown,
          amount: '50.00',
          paymentStatus: 'blocked',
        }) as unknown,
      }),
    );
  });
  it('archives without deleting employees or memberships', async () => {
    await service.archive('u', 'b', 'e');
    expect(db.businessEmployee.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'archived' }) as unknown,
      }),
    );
  });
  it('does not create a tax profile on GET', async () => {
    expect(await service.tax('u', 'b', 'e')).toEqual({ taxProfile: null });
    expect(db.employeeTaxProfile.upsert).not.toHaveBeenCalled();
  });
  it('rejects inconsistent dates against existing profile', async () => {
    db.employeeTaxProfile.findUnique.mockResolvedValue({
      employmentStartDate: new Date('2026-10-08'),
    });
    await expect(
      service.putTax('u', 'b', 'e', { employmentEndDate: '2026-10-01' }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('rejects foreign employee before tax lookup', async () => {
    db.businessEmployee.findUnique.mockResolvedValue(null);
    await expect(service.tax('u', 'b', 'foreign')).rejects.toMatchObject({
      status: 404,
    });
    expect(db.employeeTaxProfile.findUnique).not.toHaveBeenCalled();
  });
});

describe('Invitation identity and delivery', () => {
  const token = 'a'.repeat(64);
  const invite = {
    id: 'i',
    businessId: 'b',
    email: 'ada@example.com',
    invitedByUserId: 'inviter',
    employeeId: null,
    roleId: 'employee',
    status: 'pending',
    expiresAt: new Date(Date.now() + 86400000),
    role: { key: 'employee', type: 'system', status: 'active' },
    tokenHash: createHash('sha256').update(token).digest('hex'),
  };
  const db = {
    $queryRaw: jest.fn(),
    businessInvite: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  };
  const prisma = {
    ...db,
    $transaction: jest.fn(async (fn: (db: unknown) => Promise<unknown>) =>
      fn(db),
    ),
  } as unknown as PrismaService;
  const email = { sendBusinessInvitation: jest.fn() };
  const access = { lock: jest.fn() };
  const service = new InviteService(
    prisma,
    access as unknown as BusinessAccessService,
    email as unknown as EmailService,
    new ConfigService({ FRONTEND_URL: 'https://example.com' }),
  );
  beforeEach(() => {
    jest.clearAllMocks();
    db.businessInvite.findUnique.mockResolvedValue(invite);
  });
  it('rejects invalid tokens', async () => {
    db.businessInvite.findUnique.mockResolvedValue(null);
    await expect(service.accept('u', { token })).rejects.toMatchObject({
      status: 400,
    });
  });
  it('rejects expiration and replay', async () => {
    db.businessInvite.findUnique.mockResolvedValue({
      ...invite,
      expiresAt: new Date(0),
    });
    await expect(service.accept('u', { token })).rejects.toMatchObject({
      status: 410,
    });
    db.businessInvite.findUnique.mockResolvedValue({
      ...invite,
      status: 'accepted',
    });
    await expect(service.accept('u', { token })).rejects.toMatchObject({
      status: 409,
    });
  });
  it.each([
    {
      email: 'other@example.com',
      emailVerifiedAt: new Date(),
      status: 'active',
    },
    { email: 'ada@example.com', emailVerifiedAt: null, status: 'active' },
  ])('requires verified ownership of invited email %j', async (user) => {
    db.user.findUnique.mockResolvedValue(user);
    await expect(service.accept('u', { token })).rejects.toMatchObject({
      status: 403,
    });
    expect(access.lock).not.toHaveBeenCalled();
  });
  it('reports failed delivery without returning the token or its hash', async () => {
    email.sendBusinessInvitation.mockRejectedValue(
      new Error('provider failed'),
    );
    db.businessInvite.findUniqueOrThrow.mockResolvedValue({
      id: 'i',
      deliveryStatus: 'failed',
    });
    const result = await service.deliver({ invite: invite as never, token });
    expect(result).toEqual({ id: 'i', deliveryStatus: 'failed' });
    expect(db.businessInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { deliveryStatus: 'failed', deliveryAttempts: { increment: 1 } },
      }),
    );
  });
});
