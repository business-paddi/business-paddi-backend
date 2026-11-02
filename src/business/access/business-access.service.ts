import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import type { Permission } from '../../business-foundation/permission-catalog';
import { PrismaService } from '../../database/prisma.service';
import { ReadCacheService } from '../../redis/read-cache.service';

export const ROLE_INCLUDE = {
  permissions: true,
  deniedPermissions: true,
} as const;
export type Access = Awaited<ReturnType<BusinessAccessService['require']>>;
type AccessMember = Prisma.BusinessMemberGetPayload<{
  include: { role: { include: typeof ROLE_INCLUDE }; business: true };
}>;

@Injectable()
export class BusinessAccessService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly readCache?: ReadCacheService,
  ) {}

  async require(
    userId: string,
    businessId: string,
    permissions: Permission[] = [],
    db: Prisma.TransactionClient = this.prisma,
  ) {
    let member: AccessMember | null;
    if (db === this.prisma && this.readCache) {
      // Check committed versions with one indexed query instead of reloading all
      // business, membership, role, grant and denial rows on every request.
      const [version] = await this.prisma.$queryRaw<{ key: string }[]>`
        SELECT concat_ws(':', m."id", r."id",
          COALESCE(bv."revision"::text, '0'),
          COALESCE(mv."revision"::text, '0'),
          COALESCE(rv."revision"::text, '0')) AS "key"
        FROM "BusinessMember" m
        JOIN "Business" b ON b."id" = m."businessId"
        JOIN "Role" r ON r."id" = m."roleId"
        LEFT JOIN "ReadCacheRevision" bv ON bv."scope" = 'business' AND bv."entityId" = b."id"
        LEFT JOIN "ReadCacheRevision" mv ON mv."scope" = 'member' AND mv."entityId" = m."id"
        LEFT JOIN "ReadCacheRevision" rv ON rv."scope" = 'role' AND rv."entityId" = r."id"
        WHERE m."businessId" = ${businessId} AND m."userId" = ${userId}
      `;
      if (!version) throw new NotFoundException('Business not found');
      member = await this.readCache.remember(
        `bp:read:v1:access:${businessId}:${userId}:${version.key}`,
        async () => {
          const loaded = await this.loadMember(db, userId, businessId);
          this.check(loaded, []);
          return loaded!;
        },
      );
    } else {
      // Transactions, including every locked mutation, always use their own DB snapshot.
      member = await this.loadMember(db, userId, businessId);
    }
    return this.check(member, permissions);
  }

  private loadMember(
    db: Prisma.TransactionClient,
    userId: string,
    businessId: string,
  ) {
    return db.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId } },
      include: { role: { include: ROLE_INCLUDE }, business: true },
    });
  }

  private check(member: AccessMember | null, permissions: Permission[]) {
    // Hide tenant existence from outsiders.
    if (!member) throw new NotFoundException('Business not found');
    if (
      member.status !== 'active' ||
      member.role.status !== 'active' ||
      (member.role.type === 'custom' &&
        member.role.businessId !== member.businessId)
    ) {
      throw new ForbiddenException('Business access denied');
    }
    if (member.business.status !== 'active')
      throw new ForbiddenException('Business is not active');
    const denied = new Set(
      member.role.deniedPermissions.map((p) => p.permission),
    );
    const effective = member.role.permissions
      .map((p) => p.permission)
      .filter((p) => !denied.has(p));
    if (permissions.some((p) => !effective.includes(p)))
      throw new ForbiddenException('Missing business permission');
    return { member, permissions: effective };
  }

  // Lock authorization records for mutations so concurrent suspension/role changes cannot race the write.
  async lock(
    userId: string,
    businessId: string,
    permissions: Permission[],
    db: Prisma.TransactionClient,
  ) {
    await db.$queryRaw`SELECT m."id" FROM "BusinessMember" m JOIN "Role" r ON r."id" = m."roleId" JOIN "Business" b ON b."id" = m."businessId" WHERE m."businessId" = ${businessId} AND m."userId" = ${userId} FOR SHARE OF m, r, b`;
    const access = await this.require(userId, businessId, permissions, db);
    // Transaction-local attribution for database-enforced audit/notification events.
    await db.$queryRaw`SELECT set_config('business_paddi.actor_id', ${userId}, true)`;
    return access;
  }
}
