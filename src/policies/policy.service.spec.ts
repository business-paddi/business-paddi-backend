import { PolicyService } from './policy.service';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/business-access.service';

function harness() {
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    policyClass: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'class', name: 'Vacation' }]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'class', name: 'Vacation' }),
    },
    employeeGroup: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'group', name: 'Engineering' }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'group' }),
    },
    businessEmployee: {
      count: jest.fn().mockResolvedValue(2),
      findFirst: jest.fn().mockResolvedValue({ id: 'employee' }),
    },
    businessPolicy: {
      create: jest.fn(),
      findFirst: jest.fn().mockResolvedValue({
        id: 'policy',
        businessId: 'business',
        groupId: 'group',
      }),
    },
    employeePolicyAssignment: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'assignment' }),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    ...db,
    $transaction: jest.fn((run: (tx: typeof db) => Promise<unknown>) =>
      run(db),
    ),
  };
  const access = {
    require: jest.fn().mockResolvedValue({}),
    lock: jest.fn().mockResolvedValue({}),
  };
  return {
    db,
    access,
    service: new PolicyService(
      prisma as unknown as PrismaService,
      access as unknown as BusinessAccessService,
    ),
  };
}

describe('policy persistence boundaries', () => {
  it('saves a complete policy with attribution without automatically enrolling employees', async () => {
    const { db, service } = harness();
    db.businessPolicy.create.mockResolvedValue({
      id: 'policy',
      classId: 'class',
      groupId: 'group',
      name: 'Vacation — Engineering',
      durationDays: 7,
    });
    const result = await service.create('actor', 'business', {
      classId: 'class',
      groupId: 'group',
      durationDays: 7,
      startsOn: '2026-12-18',
      endsOn: '2026-12-25',
    });
    expect(result.success).toBe(true);
    expect(result.assignmentMode).toBe('explicit');
    expect(db.businessPolicy.create).toHaveBeenCalledWith({
      data: {
        businessId: 'business',
        classId: 'class',
        groupId: 'group',
        name: 'Vacation — Engineering',
        sourceText: undefined,
        durationDays: 7,
        startsOn: new Date('2026-12-18T00:00:00Z'),
        endsOn: new Date('2026-12-25T00:00:00Z'),
        createdByUserId: 'actor',
      },
    });
    expect(db.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(db.employeePolicyAssignment.create).not.toHaveBeenCalled();
  });
  it('attributes class creation and its audit to the authenticated actor in the same transaction', async () => {
    const { db, access, service } = harness();
    await service.createClasses('actor', 'business', {
      text: 'create classes Vacation',
    });
    expect(access.lock).toHaveBeenCalledWith(
      'actor',
      'business',
      ['policies:create'],
      db,
    );
    expect(db.policyClass.create).toHaveBeenCalledWith({
      data: {
        businessId: 'business',
        name: 'Vacation',
        key: 'vacation',
        createdByUserId: 'actor',
      },
    });
    expect(db.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'actor',
        businessId: 'business',
        eventType: 'business.policy.class_created',
      }) as unknown,
    });
  });
  it('does not create duplicate classes or duplicate creation audits', async () => {
    const { db, service } = harness();
    db.policyClass.findUnique.mockResolvedValue({ id: 'existing' });
    const result = await service.createClasses('actor', 'business', {
      names: ['Vacation', 'vacation'],
    });
    expect(result.createdCount).toBe(0);
    expect(db.policyClass.create).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });
  it('checks permission before parsing class requests', async () => {
    const { db, access, service } = harness();
    access.require.mockRejectedValue(new Error('denied'));
    await expect(
      service.createClasses('actor', 'business', { text: 'malformed' }),
    ).rejects.toThrow('denied');
    expect(db.policyClass.create).not.toHaveBeenCalled();
  });
  it('prevents persistence while dates or references are missing', async () => {
    const { db, service } = harness();
    await expect(
      service.create('actor', 'business', {
        classId: 'foreign',
        groupId: 'group',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.businessPolicy.create).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
    expect(db.policyClass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: 'business' } }),
    );
  });
  it('restricts assignments to active employees belonging to the policy group', async () => {
    const { db, service } = harness();
    db.businessEmployee.findFirst.mockResolvedValue(null);
    await expect(
      service.assign('actor', 'business', 'policy', 'foreign-employee'),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.employeePolicyAssignment.create).not.toHaveBeenCalled();
    expect(db.businessEmployee.findFirst).toHaveBeenCalledWith({
      where: {
        businessId: 'business',
        id: 'foreign-employee',
        status: 'active',
        groups: { some: { groupId: 'group', group: { status: 'active' } } },
      },
    });
  });
  it('returns existing assignments without a second audit', async () => {
    const { db, service } = harness();
    db.employeePolicyAssignment.findUnique.mockResolvedValue({
      id: 'existing',
    });
    expect(
      await service.assign('actor', 'business', 'policy', 'employee'),
    ).toMatchObject({ created: false });
    expect(db.employeePolicyAssignment.create).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });
  it('writes assignment and actor-attributed audit together', async () => {
    const { db, service } = harness();
    expect(
      await service.assign('actor', 'business', 'policy', 'employee'),
    ).toMatchObject({ created: true });
    expect(db.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'actor',
        eventType: 'business.policy.assigned',
        metadata: {
          assignmentId: 'assignment',
          policyId: 'policy',
          employeeId: 'employee',
        },
      }) as unknown,
    });
  });
});
