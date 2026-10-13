import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  RolePermission,
  RoleDeniedPermission,
} from '../../generated/prisma/client';

type RoleGrants = {
  permissions: RolePermission[];
  deniedPermissions: RoleDeniedPermission[];
};
@Injectable()
export class InvitePermissionsService {
  requireInviteControls(permissions: string[]): void {
    const missingPermissions = ['members:invite', 'roles:assign'].filter(
      (p) => !permissions.includes(p),
    );
    if (missingPermissions.length)
      throw new ForbiddenException({
        statusCode: 403,
        code: 'MISSING_ACCESS_CONTROL',
        message: `Missing access control: ${missingPermissions.join(', ')}`,
        missingPermissions,
      });
  }
  missingGrants(permissions: string[], role: RoleGrants): string[] {
    const denied = new Set(role.deniedPermissions.map((p) => p.permission));
    return role.permissions
      .map((p) => p.permission)
      .filter((p) => !denied.has(p) && !permissions.includes(p));
  }
  requireAssignable(permissions: string[], role: RoleGrants): void {
    const missingPermissions = this.missingGrants(permissions, role);
    if (missingPermissions.length)
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ROLE_EXCEEDS_AUTHORITY',
        message: 'You cannot approve permissions you do not possess',
        missingPermissions,
      });
  }
}
