import type { Prisma } from '../../generated/prisma/client';
import {
  allowedPermissions,
  systemRolePermissions,
  type SystemRoleKey,
  type Permission,
} from './permission-catalog';

export async function seedSystemRoles(database: Prisma.TransactionClient) {
  await database.permission.createMany({
    data: allowedPermissions.map((key) => ({ key })),
    skipDuplicates: true,
  });
  for (const key of Object.keys(systemRolePermissions) as SystemRoleKey[]) {
    const id = `system-role-${key}`;
    const role = await database.role.upsert({
      where: { id },
      create: {
        id,
        key,
        name: key.replaceAll('_', ' '),
        type: 'system',
        status: 'active',
      },
      update: {},
    });
    if (
      role.type !== 'system' ||
      role.businessId !== null ||
      role.key !== key ||
      role.status !== 'active'
    ) {
      throw new Error(`System role ${key} has incompatible stored values`);
    }
    // Exact synchronization prevents accidental privilege expansion from old grants.
    await database.rolePermission.deleteMany({
      where: {
        roleId: role.id,
        permission: { notIn: systemRolePermissions[key] },
      },
    });
    await database.roleDeniedPermission.deleteMany({
      where: { roleId: role.id },
    });
    await database.rolePermission.createMany({
      data: systemRolePermissions[key].map((permission: Permission) => ({
        roleId: role.id,
        permission,
      })),
      skipDuplicates: true,
    });
  }
}

export async function seedEmployeeTypes(
  database: Prisma.TransactionClient,
  businessId: string,
) {
  for (const key of [
    'full_time',
    'part_time',
    'contractor',
    'intern',
    'temporary',
  ]) {
    await database.employeeType.upsert({
      where: { businessId_key: { businessId, key } },
      create: { businessId, key, name: key.replaceAll('_', ' ') },
      update: {},
    });
  }
}
