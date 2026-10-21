import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  GroupDto,
  UpdateGroupDto,
  EmployeeTypeDto,
  UpdateEmployeeDto,
  EmployeeQueryDto,
} from './business.dto';
import { ScheduleEmployeeDeletionDto } from './employee-lifecycle.dto';
import {
  planEmployeeLifecycle,
  EmployeeLifecycleService,
} from './employee-lifecycle.service';
import { GroupService } from './group.service';
import { GROUP_ICONS } from './group-appearance';
import { employeeResponse } from './business.responses';
import { isEmployeeLocked } from './employee-status';
import type { PrismaService } from '../database/prisma.service';
import type { BusinessAccessService } from './business-access.service';
import type { BusinessEmployee } from '../../generated/prisma/client';

const options = { whitelist: true, forbidNonWhitelisted: true };
const now = new Date('2030-01-01T12:00:00Z');
const future = new Date('2030-01-02T12:00:00Z');
const current = {
  status: 'active' as const,
  deletionScheduledAt: null,
  deletionRequestedAt: null,
  deletionRequestedByUserId: null,
  statusBeforeDeletion: null,
  deletedAt: null,
};

describe('group appearance contracts', () => {
  it('accepts all supported icons, custom six-digit colours and nullable defaults', async () => {
    for (const icon of GROUP_ICONS)
      expect(
        await validate(
          plainToInstance(GroupDto, {
            name: 'Engineering',
            color: '#aAbB12',
            icon,
          }),
          options,
        ),
      ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(GroupDto, {
          name: 'Engineering',
          color: null,
          icon: null,
        }),
        options,
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(UpdateGroupDto, { color: null, icon: null }),
        options,
      ),
    ).toHaveLength(0);
  });
  it('rejects invalid hex, arbitrary icon names and foreign/unknown fields', async () => {
    for (const color of ['red', '#123', '#12345678', '#gggggg', '123456'])
      expect(
        (
          await validate(
            plainToInstance(GroupDto, { name: 'E', color }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
    for (const input of [
      { icon: 'Anything' },
      { businessId: 'foreign' },
      { name: null },
    ])
      expect(
        (await validate(plainToInstance(UpdateGroupDto, input), options))
          .length,
      ).toBeGreaterThan(0);
  });
  it('does not accidentally add appearance fields to employee type creation', async () => {
    expect(
      (
        await validate(
          plainToInstance(EmployeeTypeDto, {
            name: 'Full time',
            key: 'full_time',
            color: '#ffffff',
          }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('checks existing group-update permissions and scopes all lookups to the business', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      employeeGroup: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const prisma = {
      ...db,
      $transaction: jest.fn((run: (tx: typeof db) => Promise<unknown>) =>
        run(db),
      ),
    };
    const access = { lock: jest.fn().mockResolvedValue({}) };
    const service = new GroupService(
      prisma as unknown as PrismaService,
      access as unknown as BusinessAccessService,
    );
    await expect(
      service.update('actor', 'business', 'foreign', { color: '#ffffff' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(access.lock).toHaveBeenCalledWith(
      'actor',
      'business',
      ['employee_lists:update'],
      db,
    );
    expect(db.employeeGroup.findUnique).toHaveBeenCalledWith({
      where: { businessId_id: { businessId: 'business', id: 'foreign' } },
    });
    expect(db.employeeGroup.update).not.toHaveBeenCalled();
    access.lock.mockRejectedValue(new ForbiddenException());
    await expect(
      service.update('actor', 'business', 'group', { color: '#ffffff' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('preserves untouched appearance values and lets explicit null restore defaults', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      employeeGroup: {
        findUnique: jest.fn().mockResolvedValue({ status: 'active' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      ...db,
      $transaction: jest.fn((run: (tx: typeof db) => Promise<unknown>) =>
        run(db),
      ),
    };
    const service = new GroupService(
      prisma as unknown as PrismaService,
      { lock: jest.fn() } as unknown as BusinessAccessService,
    );
    await service.update('actor', 'business', 'group', { icon: null });
    expect(db.employeeGroup.update).toHaveBeenCalledWith({
      where: { businessId_id: { businessId: 'business', id: 'group' } },
      data: { icon: null },
    });
    await expect(
      service.update('actor', 'business', 'group', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('employee deletion lifecycle', () => {
  it('allows canonical states as list filters but not through ordinary employee editing', async () => {
    for (const status of ['scheduled_for_deletion', 'deleted']) {
      expect(
        await validate(plainToInstance(EmployeeQueryDto, { status }), options),
      ).toHaveLength(0);
      expect(
        (
          await validate(
            plainToInstance(UpdateEmployeeDto, { status }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
    }
  });
  it('requires a timestamp with an explicit timezone', async () => {
    for (const scheduledFor of [
      '2030-01-02',
      '2030-01-02T12:00:00',
      '2030-02-30T12:00:00Z',
    ])
      expect(
        (
          await validate(
            plainToInstance(ScheduleEmployeeDeletionDto, { scheduledFor }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
    expect(
      await validate(
        plainToInstance(ScheduleEmployeeDeletionDto, {
          scheduledFor: '2030-01-02T13:00:00+01:00',
        }),
        options,
      ),
    ).toHaveLength(0);
  });
  it('schedules inactive-for-payment status while recording the prior status', () => {
    expect(
      planEmployeeLifecycle(current, 'schedule', now, 'actor', future),
    ).toMatchObject({
      status: 'scheduled_for_deletion',
      statusBeforeDeletion: 'active',
      deletionScheduledAt: future,
      deletionRequestedByUserId: 'actor',
      paymentStatus: 'blocked',
    });
    expect(() =>
      planEmployeeLifecycle(current, 'schedule', now, 'actor', now),
    ).toThrow(BadRequestException);
  });
  it('makes identical schedules idempotent and rejects accidental rescheduling', () => {
    const pending = {
      ...current,
      status: 'scheduled_for_deletion' as const,
      deletionScheduledAt: future,
      statusBeforeDeletion: 'active',
    };
    expect(
      planEmployeeLifecycle(pending, 'schedule', now, 'actor', future),
    ).toBeNull();
    expect(() =>
      planEmployeeLifecycle(
        pending,
        'schedule',
        now,
        'actor',
        new Date(future.getTime() + 1000),
      ),
    ).toThrow(ConflictException);
  });
  it('cancels before the boundary and restores the previous status without enabling payment', () => {
    const pending = {
      ...current,
      status: 'scheduled_for_deletion' as const,
      deletionScheduledAt: future,
      statusBeforeDeletion: 'on_leave',
    };
    expect(
      planEmployeeLifecycle(pending, 'cancel', now, 'actor'),
    ).toMatchObject({
      status: 'on_leave',
      deletionScheduledAt: null,
      statusBeforeDeletion: null,
      paymentStatus: 'blocked',
    });
    expect(() =>
      planEmployeeLifecycle(pending, 'cancel', future, 'actor'),
    ).toThrow(ConflictException);
  });
  it('soft deletes and restores to archived without erasing employee/account data', () => {
    const deleted = {
      ...current,
      status: 'deleted' as const,
      deletedAt: now,
      statusBeforeDeletion: 'active',
    };
    const data = planEmployeeLifecycle(current, 'delete', now, 'actor');
    expect(data).toMatchObject({
      status: 'deleted',
      deletedAt: now,
      paymentStatus: 'blocked',
    });
    expect(data).not.toHaveProperty('businessMemberId');
    expect(data).not.toHaveProperty('fullName');
    expect(planEmployeeLifecycle(deleted, 'delete', now, 'actor')).toBeNull();
    expect(
      planEmployeeLifecycle(deleted, 'restore', now, 'actor'),
    ).toMatchObject({
      status: 'archived',
      deletedAt: null,
      paymentStatus: 'blocked',
    });
    expect(() =>
      planEmployeeLifecycle(deleted, 'schedule', now, 'actor', future),
    ).toThrow(ConflictException);
  });
  it('supplies lifecycle fields independently of platform membership', () => {
    const employee = {
      ...current,
      id: 'employee',
      businessId: 'business',
      businessMemberId: null,
      status: 'scheduled_for_deletion',
      deletionScheduledAt: future,
    } as BusinessEmployee;
    const response = employeeResponse(employee);
    expect(response).toMatchObject({
      businessMemberId: null,
      status: 'scheduled_for_deletion',
      deletionScheduledAt: future,
      deletedAt: null,
    });
    expect(isEmployeeLocked('scheduled_for_deletion')).toBe(true);
    expect(isEmployeeLocked('deleted')).toBe(true);
    expect(isEmployeeLocked('active')).toBe(false);
  });
  it('authorizes before mutating and cannot delete a foreign business employee', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      businessEmployee: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      auditEvent: { create: jest.fn() },
    };
    const prisma = {
      ...db,
      $transaction: jest.fn((run: (tx: typeof db) => Promise<unknown>) =>
        run(db),
      ),
    };
    const access = { lock: jest.fn().mockResolvedValue({}) };
    const service = new EmployeeLifecycleService(
      prisma as unknown as PrismaService,
      access as unknown as BusinessAccessService,
    );
    await expect(
      service.mutate('actor', 'business', 'foreign', 'delete'),
    ).rejects.toMatchObject({ status: 404 });
    expect(access.lock).toHaveBeenCalledWith(
      'actor',
      'business',
      ['employees:archive'],
      db,
    );
    expect(db.businessEmployee.update).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });
});
