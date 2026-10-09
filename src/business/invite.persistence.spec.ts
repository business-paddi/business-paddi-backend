import { createHash } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from './business-access.service';
import { InviteService } from './invite.service';

describe('Invitation persistence and acceptance transactions', () => {
  const role = {
    id: 'system-role-employee',
    key: 'employee',
    type: 'system',
    businessId: null,
    status: 'active',
    permissions: [],
    deniedPermissions: [],
  };
  const db = {
    $queryRaw: jest.fn(),
    role: { findFirst: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    businessInvite: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    businessMember: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    businessEmployee: { findUnique: jest.fn(), update: jest.fn() },
    userNotification: { create: jest.fn() },
  };
  const transaction = jest.fn(
    async (fn: (database: unknown) => Promise<unknown>) => fn(db),
  );
  const access = { lock: jest.fn() };
  const service = new InviteService(
    { ...db, $transaction: transaction } as unknown as PrismaService,
    access as unknown as BusinessAccessService,
  );
  const token = 'a'.repeat(64);
  const stored = {
    id: 'i',
    businessId: 'b',
    employeeId: 'e',
    invitedByUserId: 'owner',
    email: 'ada@example.com',
    roleId: role.id,
    role,
    status: 'pending',
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 86400000),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    access.lock.mockResolvedValue({
      permissions: ['members:invite', 'members:update_status', 'roles:assign'],
    });
    db.role.findFirst.mockResolvedValue(role);
    db.role.findUnique.mockResolvedValue(role);
    db.user.findUnique.mockResolvedValue({
      email: 'ada@example.com',
      emailVerifiedAt: new Date(),
      status: 'active',
      id: 'u',
    });
    db.businessMember.findUnique.mockResolvedValue(null);
    db.businessMember.create.mockResolvedValue({
      id: 'm',
      role,
      roleId: role.id,
    });
    db.businessEmployee.findUnique.mockResolvedValue({
      id: 'e',
      email: 'ada@example.com',
      businessMemberId: null,
      status: 'active',
    });
    db.businessInvite.findUnique.mockResolvedValue(stored);
    db.businessInvite.create.mockImplementation(
      (input: { data: Record<string, unknown> }) => ({
        id: 'i',
        ...input.data,
      }),
    );
    db.businessInvite.update.mockResolvedValue({ id: 'i', status: 'accepted' });
  });
  it('stores only a secure hash with default employee role, without membership creation', async () => {
    const delivery = await service.record(db as never, 'owner', 'b', {
      email: 'ada@example.com',
      employeeId: 'e',
    });
    expect(delivery.token).toMatch(/^[a-f0-9]{64}$/);
    expect(db.businessInvite.create).toHaveBeenCalledWith({
      data: {
        businessId: 'b',
        email: 'ada@example.com',
        employeeId: 'e',
        roleId: role.id,
        invitedByUserId: 'owner',
        tokenHash: createHash('sha256').update(delivery.token).digest('hex'),
        deliveryStatus: 'pending',
        expiresAt: delivery.invite.expiresAt,
      },
    });
    expect(db.businessMember.create).not.toHaveBeenCalled();
  });
  it('supports an invitation without an employee or existing user', async () => {
    db.user.findUnique.mockResolvedValue(null);
    await service.record(db as never, 'owner', 'b', {
      email: 'new@example.com',
    });
    expect(db.businessEmployee.findUnique).not.toHaveBeenCalled();
    expect(db.businessMember.create).not.toHaveBeenCalled();
    expect(db.userNotification.create).not.toHaveBeenCalled();
  });
  it('creates an in-app notification for an existing customer', async () => {
    const result = await service.create('owner', 'b', {
      email: 'ada@example.com',
    });
    expect(result.invitation.deliveryStatus).toBe('pending');
    expect(result.invitation).not.toHaveProperty('tokenHash');
    expect(result.invitation).not.toHaveProperty('token');
    expect(db.userNotification.create).toHaveBeenCalledWith({
      data: { userId: 'u', inviteId: 'i' },
    });
  });
  it('accepts an invite by ID with verified email ownership', async () => {
    const result = await service.acceptById('u', 'i');
    expect(result.membership.id).toBe('m');
    expect(db.businessInvite.findUnique).toHaveBeenCalledWith({
      where: { id: 'i' },
      include: { role: true },
    });
  });
  it('does not allow a different customer to accept by ID', async () => {
    db.user.findUnique.mockResolvedValue({
      email: 'other@example.com',
      emailVerifiedAt: new Date(),
      status: 'active',
    });
    await expect(service.acceptById('other', 'i')).rejects.toMatchObject({
      status: 403,
    });
    expect(db.businessMember.create).not.toHaveBeenCalled();
  });
  it('lists only invitations for the signed-in customer email without exposing tokens', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue({ email: 'ada@example.com' });
    db.businessInvite.findMany.mockResolvedValue([
      { id: 'i', status: 'pending', expiresAt: new Date(0) },
    ]);
    const result = await service.personalList('u');
    const query = db.businessInvite.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ email: 'ada@example.com' });
    expect(query.select).not.toHaveProperty('tokenHash');
    expect(result.items[0].status).toBe('expired');
  });
  it('rejects foreign employee references and email mismatch', async () => {
    db.businessEmployee.findUnique.mockResolvedValue(null);
    await expect(
      service.record(db as never, 'owner', 'b', {
        email: 'ada@example.com',
        employeeId: 'foreign',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.businessInvite.create).not.toHaveBeenCalled();
  });
  it('rejects ownership invitations and foreign custom roles', async () => {
    db.role.findUnique.mockResolvedValue({ ...role, key: 'owner' });
    await expect(
      service.record(db as never, 'owner', 'b', {
        email: 'ada@example.com',
        roleId: 'owner',
      }),
    ).rejects.toMatchObject({ status: 400 });
    db.role.findUnique.mockResolvedValue({
      ...role,
      type: 'custom',
      businessId: 'foreign',
    });
    await expect(
      service.record(db as never, 'owner', 'b', {
        email: 'ada@example.com',
        roleId: 'foreign',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('administrators need roles:assign to grant roles beyond system employee', async () => {
    access.lock.mockResolvedValue({ permissions: ['members:invite'] });
    db.role.findUnique.mockResolvedValue({ ...role, key: 'admin' });
    await expect(
      service.record(db as never, 'admin', 'b', {
        email: 'ada@example.com',
        roleId: 'admin',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('acceptance creates membership, links employee and records acceptance in one transaction', async () => {
    const result = await service.accept('ada', { token });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(db.businessMember.create).toHaveBeenCalledWith({
      data: {
        businessId: 'b',
        userId: 'ada',
        roleId: role.id,
        invitedByUserId: 'owner',
      },
      include: {
        role: { include: { permissions: true, deniedPermissions: true } },
      },
    });
    expect(db.businessEmployee.update).toHaveBeenCalledWith({
      where: { businessId_id: { businessId: 'b', id: 'e' } },
      data: { businessMemberId: 'm' },
    });
    expect(db.businessInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'accepted' }) as unknown,
      }),
    );
    expect(result.membership.role.key).toBe('employee');
  });
  it('never replaces an active or owner membership', async () => {
    db.businessMember.findUnique.mockResolvedValue({
      id: 'm',
      status: 'active',
      roleId: role.id,
      role,
    });
    await expect(service.accept('ada', { token })).rejects.toMatchObject({
      status: 409,
    });
    expect(db.businessMember.update).not.toHaveBeenCalled();
  });
});
