import { BusinessService } from './business.service';
import type { PrismaService } from '../database/prisma.service';
import type { BusinessAccessService } from './business-access.service';
import type { EmployeeService } from './employee.service';
import type { InviteService } from './invite.service';

describe('Member profile permissions and composition', () => {
  const db = { businessMember: { findUnique: jest.fn() } };
  const access = { require: jest.fn() };
  const employees = { get: jest.fn(), tax: jest.fn() };
  const service = new BusinessService(
    db as unknown as PrismaService,
    access as unknown as BusinessAccessService,
    {} as InviteService,
    employees as unknown as EmployeeService,
  );
  const member = {
    id: 'm',
    businessId: 'b',
    userId: 'u',
    createdAt: new Date(),
    user: { id: 'u', name: 'Ada', avatar: null, email: 'ada@example.com' },
    role: {
      id: 'r',
      permissions: [{ permission: 'reports:view' }],
      deniedPermissions: [{ permission: 'reports:view' }],
    },
    employee: {
      id: 'e',
      employeeType: { id: 't', name: 'Full time', key: 'full_time' },
      managerEmployee: null,
      groups: [{ group: { id: 'g', name: 'Finance' } }],
    },
  };
  beforeEach(() => {
    jest.resetAllMocks();
    access.require.mockResolvedValue({
      member: { id: 'viewer' },
      permissions: ['members:view', 'employees:view', 'employees:update'],
    });
    db.businessMember.findUnique.mockResolvedValue(member);
    employees.get.mockResolvedValue({
      employee: { id: 'e', accountNumber: '1234567890' },
    });
    employees.tax.mockResolvedValue({ taxProfile: { id: 'tax' } });
  });
  it('combines user, role, employee, banking and tax with a tenant-scoped lookup', async () => {
    const result = await service.member('viewer', 'b', 'm');
    expect(access.require).toHaveBeenCalledWith('viewer', 'b', [
      'members:view',
    ]);
    expect(db.businessMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId_id: { businessId: 'b', id: 'm' } },
      }),
    );
    expect(result.member.user.email).toBe('ada@example.com');
    expect(result.member.role.effectivePermissions).toEqual([]);
    expect(result.employee).toMatchObject({
      id: 'e',
      accountNumber: '1234567890',
      groups: [{ id: 'g', name: 'Finance' }],
    });
    expect(result.taxProfile).toEqual({ id: 'tax' });
    expect(result.member).not.toHaveProperty('employee');
  });
  it('supports members without employee records', async () => {
    db.businessMember.findUnique.mockResolvedValue({
      ...member,
      employee: null,
    });
    const result = await service.member('viewer', 'b', 'm');
    expect(result.hasEmployee).toBe(false);
    expect(result.employee).toBeNull();
    expect(result.taxProfile).toBeNull();
    expect(employees.get).not.toHaveBeenCalled();
  });
  it('does not fetch employee or tax details with only members:view', async () => {
    access.require.mockResolvedValue({
      member: { id: 'viewer' },
      permissions: ['members:view'],
    });
    const result = await service.member('viewer', 'b', 'm');
    expect(result.hasEmployee).toBe(true);
    expect(result.employee).toBeNull();
    expect(result.access).toEqual({
      canViewEmployee: false,
      canViewFinancials: false,
      canViewTax: false,
    });
    expect(employees.get).not.toHaveBeenCalled();
    expect(employees.tax).not.toHaveBeenCalled();
  });
  it('allows employee self-access without granting banking or tax access', async () => {
    access.require.mockResolvedValue({
      member: { id: 'm' },
      permissions: ['members:view', 'employees:view_own'],
    });
    employees.get.mockResolvedValue({ employee: { id: 'e' } });
    const result = await service.member('u', 'b', 'm');
    expect(result.employee?.id).toBe('e');
    expect(result.access).toEqual({
      canViewEmployee: true,
      canViewFinancials: false,
      canViewTax: false,
    });
    expect(employees.tax).not.toHaveBeenCalled();
  });
  it('omits tax for employee viewers without employees:update', async () => {
    access.require.mockResolvedValue({
      member: { id: 'viewer' },
      permissions: ['members:view', 'employees:view'],
    });
    employees.get.mockResolvedValue({ employee: { id: 'e' } });
    const result = await service.member('viewer', 'b', 'm');
    expect(result.employee).not.toHaveProperty('accountNumber');
    expect(result.taxProfile).toBeNull();
    expect(employees.tax).not.toHaveBeenCalled();
  });
  it('returns 404 for missing or foreign members', async () => {
    db.businessMember.findUnique.mockResolvedValue(null);
    await expect(
      service.member('viewer', 'b', 'foreign'),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('stops immediately when the viewer lacks members:view', async () => {
    access.require.mockRejectedValue(new Error('forbidden'));
    await expect(service.member('viewer', 'b', 'm')).rejects.toThrow(
      'forbidden',
    );
    expect(db.businessMember.findUnique).not.toHaveBeenCalled();
  });
});
