import type {
  BusinessEmployee,
  BusinessInvite,
  Role,
  RolePermission,
  RoleDeniedPermission,
  Prisma,
} from '../../generated/prisma/client';
export const EMPLOYEE_INCLUDE = {
  businessMember: {
    select: {
      id: true,
      user: { select: { name: true, avatar: true, email: true } },
    },
  },
} as const satisfies Prisma.BusinessEmployeeInclude;

type EmployeeWithMember = BusinessEmployee &
  Partial<
    Prisma.BusinessEmployeeGetPayload<{ include: typeof EMPLOYEE_INCLUDE }>
  >;
export const INVITE_SELECT = {
  id: true,
  businessId: true,
  email: true,
  employeeId: true,
  roleId: true,
  invitedByUserId: true,
  status: true,
  deliveryStatus: true,
  deliveryAttempts: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
export function roleResponse(
  role: Role & {
    permissions: RolePermission[];
    deniedPermissions: RoleDeniedPermission[];
  },
  memberCount?: number,
) {
  const grantedPermissions = role.permissions.map((p) => p.permission);
  const deniedPermissions = role.deniedPermissions.map((p) => p.permission);
  return {
    id: role.id,
    businessId: role.businessId,
    name: role.name,
    key: role.key,
    type: role.type,
    status: role.status,
    grantedPermissions,
    deniedPermissions,
    effectivePermissions: grantedPermissions.filter(
      (p) => !deniedPermissions.includes(p),
    ),
    ...(memberCount === undefined ? {} : { memberCount }),
  };
}
export function employeeResponse(
  employee: EmployeeWithMember,
  financial = false,
) {
  const base = {
    id: employee.id,
    businessId: employee.businessId,
    businessMemberId: employee.businessMemberId,
    businessMember: employee.businessMember ?? null,
    fullName: employee.fullName,
    email: employee.email,
    state: employee.state,
    employeeTypeId: employee.employeeTypeId,
    managerEmployeeId: employee.managerEmployeeId,
    jobTitle: employee.jobTitle,
    status: employee.status,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
  };
  return financial
    ? {
        ...base,
        amount: employee.amount?.toFixed(2) ?? null,
        payFrequency:
          employee.payFrequency === 'bi_weekly'
            ? 'bi-weekly'
            : employee.payFrequency,
        currency: employee.currency,
        paymentStatus: employee.paymentStatus,
        paymentBlockedReason: employee.paymentBlockedReason,
        accountVerificationStatus: employee.accountVerificationStatus,
        bankDetailsConfigured: !!(employee.bankCode && employee.accountNumber),
      }
    : base;
}
export function inviteResponse(invite: BusinessInvite) {
  const { tokenHash: _tokenHash, ...safe } = invite;
  void _tokenHash;
  return safe;
}
