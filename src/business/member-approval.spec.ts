import type { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from './business-access.service';
import { InvitePermissionsService } from './invite-permissions.service';
import { MemberApprovalService } from './member-approval.service';

describe('Membership review authorization and audit', () => {
  const role = {
    id: 'role',
    key: 'report_reader',
    type: 'custom',
    businessId: 'b',
    status: 'active',
    permissions: [{ permission: 'reports:view' }],
    deniedPermissions: [],
  };
  const member = {
    id: 'm',
    businessId: 'b',
    userId: 'recipient',
    roleId: role.id,
    status: 'pending_approval',
    approvalStatus: 'pending',
  };
  const db = {
    $queryRaw: jest.fn(),
    businessMember: { findFirst: jest.fn(), update: jest.fn() },
    role: { findUniqueOrThrow: jest.fn() },
  };
  const access = { lock: jest.fn() };
  const service = new MemberApprovalService(
    {
      $transaction: async (fn: (db: unknown) => Promise<unknown>) => fn(db),
    } as unknown as PrismaService,
    access as unknown as BusinessAccessService,
    new InvitePermissionsService(),
  );
  beforeEach(() => {
    jest.clearAllMocks();
    access.lock.mockResolvedValue({
      permissions: ['roles:assign', 'reports:view'],
    });
    db.businessMember.findFirst.mockResolvedValue(member);
    db.role.findUniqueOrThrow.mockResolvedValue(role);
    db.businessMember.update.mockImplementation((input: { data: object }) => ({
      ...member,
      ...input.data,
      role,
    }));
  });
  it('writes the removal audit fields when rejecting a membership', async () => {
    const result = await service.review(
      'reviewer',
      'b',
      'm',
      false,
      'Not authorized',
    );
    expect(result.membership.status).toBe('removed');
    expect(result.membership.removedByUserId).toBe('reviewer');
    expect(result.membership.removedAt).toEqual(
      result.membership.approvalReviewedAt,
    );
    expect(result.membership.approvalReason).toBe('Not authorized');
    expect(result.membership.role.effectivePermissions).toEqual([]);
  });
  it('requires target grants and leaves membership untouched on failure', async () => {
    access.lock.mockResolvedValue({ permissions: ['roles:assign'] });
    await expect(
      service.review('reviewer', 'b', 'm', true),
    ).rejects.toMatchObject({
      response: {
        code: 'ROLE_EXCEEDS_AUTHORITY',
        missingPermissions: ['reports:view'],
      },
    });
    expect(db.businessMember.update).not.toHaveBeenCalled();
  });
  it('does not review a foreign or already reviewed membership', async () => {
    db.businessMember.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.review('reviewer', 'other', 'm', true),
    ).rejects.toMatchObject({ status: 404 });
    db.businessMember.findFirst.mockResolvedValueOnce({
      ...member,
      status: 'active',
      approvalStatus: 'approved',
    });
    await expect(
      service.review('reviewer', 'b', 'm', true),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.businessMember.update).not.toHaveBeenCalled();
  });
});
