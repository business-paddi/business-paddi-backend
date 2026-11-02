import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ExecutionContext } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';
import type { PrismaService } from '../../src/database/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import { ReadCacheService } from '../../src/redis/read-cache.service';
import { BusinessAccessService } from '../../src/business/access/business-access.service';
import { UsersService } from '../../src/users/users.service';
import { AccessTokenGuard } from '../../src/identity/auth-guard/access-token.guard';
import type { AuthTokenService } from '../../src/identity/auth-token/auth-token.service';
import type { AuthenticatedRequest } from '../../src/identity/auth-guard/authenticated-request';
import { databaseErrorSummary } from '../lib/database-error';

async function main() {
  assert.ok(
    process.env.DATABASE_URL && process.env.REDIS_URL,
    'DATABASE_URL and REDIS_URL required',
  );
  const schema = `read_cache_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30000,
  });
  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', () => {});
  const keys = new Set<string>();
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let created = false;
  let passed = 0;
  const check = (name: string, ok: unknown) => {
    assert.ok(ok, name);
    console.log(`PASS: ${name}`);
    passed++;
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const url = new URL(process.env.DATABASE_URL!);
    url.hostname = url.hostname.replace('-pooler.', '.');
    pool = new Pool({
      connectionString: url.toString(),
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 30000,
    });
    assert.equal(
      (await pool.query('SELECT current_schema() AS name')).rows[0].name,
      schema,
    );
    for (const entry of (
      await readdir('prisma/migrations', { withFileTypes: true })
    )
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      let sql = (
        await readFile(`prisma/migrations/${entry.name}/migration.sql`, 'utf8')
      ).replace('CREATE SCHEMA IF NOT EXISTS "public";', '');
      const addition = sql.match(
        /^ALTER TYPE "BusinessMemberStatus" ADD VALUE IF NOT EXISTS 'pending_approval';/,
      );
      if (addition) {
        await pool.query(addition[0]);
        sql = sql.slice(addition[0].length);
      }
      await pool.query(sql);
    }
    await redis.connect();
    const client = new PrismaClient({
      adapter: new PrismaPg(pool, { schema }),
    });
    prisma = client;
    // Prove that generated ORM queries use the isolated schema before any ORM write.
    const probeId = `${schema}_probe`;
    await pool.query(
      'INSERT INTO "Business" ("id", "name", "updatedAt") VALUES ($1, $2, now())',
      [probeId, 'Schema isolation probe'],
    );
    assert.equal(
      (await client.business.findUniqueOrThrow({ where: { id: probeId } }))
        .name,
      'Schema isolation probe',
    );
    const db = client as unknown as PrismaService;
    let reads = 0;
    let writes = 0;
    const cacheRedis = {
      client: {
        get isReady() {
          return redis.isReady;
        },
        get: (key: string) => {
          reads++;
          keys.add(key);
          return redis.get(key);
        },
        set: (key: string, value: string, options: { EX: number }) => {
          writes++;
          keys.add(key);
          return redis.set(key, value, options);
        },
      },
    } as unknown as RedisService;
    const cache = new ReadCacheService(cacheRedis);
    const access = new BusinessAccessService(db, cache);
    const secondInstance = new BusinessAccessService(
      db,
      new ReadCacheService(cacheRedis),
    );
    const users = new UsersService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      cache,
    );
    const userId = `${schema}_user`;
    const otherId = `${schema}_other`;
    await client.user.createMany({
      data: [
        {
          id: userId,
          email: `${userId}@example.invalid`,
          name: 'David',
          emailVerifiedAt: new Date(),
        },
        {
          id: otherId,
          email: `${otherId}@example.invalid`,
          name: 'Amaka',
          emailVerifiedAt: new Date(),
        },
      ],
    });
    const business = await client.business.create({
      data: { name: 'Cache test workspace' },
    });
    const foreign = await client.business.create({
      data: { name: 'Other workspace' },
    });
    const role = await client.role.create({
      data: {
        businessId: business.id,
        name: 'Reader',
        key: 'reader',
        type: 'custom',
        permissions: { create: { permission: 'reports:view' } },
      },
    });
    const member = await client.businessMember.create({
      data: { businessId: business.id, userId, roleId: role.id },
    });
    await client.businessMember.create({
      data: { businessId: business.id, userId: otherId, roleId: role.id },
    });
    const session = await client.userSession.create({
      data: { userId, currentAuthSessionId: `${schema}_auth` },
    });
    const guard = new AccessTokenGuard(
      {
        verifyAccessToken: async () => ({
          userId,
          userSessionId: session.userSessionId,
          tokenId: 'test-token',
        }),
      } as unknown as AuthTokenService,
      db,
    );
    const principal = async () => {
      const request = {
        cookies: { accessToken: 'test-token' },
      } as unknown as AuthenticatedRequest;
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
      await guard.canActivate(context);
      return request.auth;
    };
    const currentUser = async () =>
      users.getCurrentUser(userId, (await principal()).userCacheRevision);
    const revision = async (scope: string, entityId: string) =>
      (
        await client.readCacheRevision.findUniqueOrThrow({
          where: { scope_entityId: { scope, entityId } },
        })
      ).revision;

    const first = await currentUser();
    const beforeUserHit = writes;
    assert.deepEqual(await currentUser(), first);
    check(
      'current user is reused from real Redis without another cache fill',
      writes === beforeUserHit,
    );
    check(
      'password hashes and session credentials are excluded',
      !('passwordHash' in first) && !('sessions' in first),
    );
    const userKey = [...keys].find((k) =>
      k.startsWith(`bp:read:v1:user:${userId}:`),
    )!;
    const ttl = await redis.ttl(userKey);
    check(
      'cached payload has a finite five-minute expiry',
      ttl > 0 && ttl <= 300,
    );
    await client.user.update({
      where: { id: userId },
      data: { name: 'David Updated' },
    });
    check(
      'profile change immediately selects a fresh user snapshot',
      (await currentUser()).name === 'David Updated',
    );
    await client.userPreference.create({
      data: { userId, sidebarMinimized: true },
    });
    check(
      'preference insertion invalidates current-user data',
      (await currentUser()).preferences.sidebarMinimized,
    );
    await client.userPreference.update({
      where: { userId },
      data: { sidebarMinimized: false },
    });
    check(
      'preference update invalidates the shared preferences snapshot',
      !(
        await users.getPreferences(
          userId,
          (await principal()).userCacheRevision,
        )
      ).sidebarMinimized,
    );
    await client.authProvider.create({
      data: { userId, provider: 'GOOGLE', providerUserId: schema },
    });
    check(
      'provider linking invalidates current-user data',
      (await currentUser()).authProviders.length === 1,
    );
    await client.authProvider.deleteMany({ where: { userId } });
    check(
      'provider unlinking invalidates current-user data',
      (await currentUser()).authProviders.length === 0,
    );
    await client.user.update({
      where: { id: userId },
      data: { passwordHash: 'test-only-hash' },
    });
    check(
      'password change refreshes hasPassword',
      (await currentUser()).hasPassword,
    );

    await access.require(userId, business.id, ['reports:view']);
    const beforeAccessHit = writes;
    await secondInstance.require(userId, business.id, ['reports:view']);
    check(
      'workspace snapshot is reused by a second backend instance',
      writes === beforeAccessHit,
    );
    await assert.rejects(
      access.require(userId, foreign.id),
      /Business not found/,
    );
    check('cached membership cannot grant access to another business', true);
    await assert.rejects(
      access.require(userId, business.id, ['members:remove']),
      /Missing business permission/,
    );
    check('requested permissions are checked on cache hits', true);

    await access.require(otherId, business.id);
    await client.business.update({
      where: { id: business.id },
      data: { name: 'Edited by another member' },
    });
    check(
      'business edits refresh every member on the next read',
      (await access.require(userId, business.id)).member.business.name ===
        'Edited by another member' &&
        (await secondInstance.require(otherId, business.id)).member.business
          .name === 'Edited by another member',
    );
    const originalVersion = await revision('business', business.id);
    await assert.rejects(
      client.$transaction(async (tx) => {
        await tx.business.update({
          where: { id: business.id },
          data: { name: 'Rolled back' },
        });
        throw new Error('rollback test');
      }),
      /rollback test/,
    );
    check(
      'rollback also rolls back revision invalidation',
      originalVersion === (await revision('business', business.id)),
    );

    await client.roleDeniedPermission.create({
      data: { roleId: role.id, permission: 'reports:view' },
    });
    await assert.rejects(
      access.require(userId, business.id, ['reports:view']),
      /Missing business permission/,
    );
    await assert.rejects(
      secondInstance.require(otherId, business.id, ['reports:view']),
      /Missing business permission/,
    );
    check(
      'role denial invalidates all affected members across instances',
      true,
    );
    await client.roleDeniedPermission.deleteMany({
      where: { roleId: role.id },
    });
    check(
      'removing a denial restores the grant without waiting for TTL',
      (await access.require(userId, business.id)).permissions.includes(
        'reports:view',
      ),
    );
    await client.rolePermission.deleteMany({ where: { roleId: role.id } });
    await assert.rejects(
      access.require(userId, business.id, ['reports:view']),
      /Missing business permission/,
    );
    check('grant deletion invalidates access immediately', true);
    await client.rolePermission.create({
      data: { roleId: role.id, permission: 'reports:view' },
    });
    check(
      'grant insertion invalidates access immediately',
      (await access.require(userId, business.id)).permissions.includes(
        'reports:view',
      ),
    );

    const beforeTxReads = reads;
    await client.$transaction(async (tx) => {
      await access.lock(userId, business.id, ['reports:view'], tx);
    });
    check(
      'locked mutation authorization bypasses Redis',
      reads === beforeTxReads,
    );
    await client.businessMember.update({
      where: { id: member.id },
      data: {
        status: 'suspended',
        statusUpdatedByUserId: otherId,
        statusUpdatedAt: new Date(),
      },
    });
    await assert.rejects(
      access.require(userId, business.id),
      /Business access denied/,
    );
    check('member suspension overrides a warmed Redis entry', true);
    await client.businessMember.update({
      where: { id: member.id },
      data: {
        status: 'active',
        statusUpdatedByUserId: otherId,
        statusUpdatedAt: new Date(),
      },
    });
    await access.require(userId, business.id);
    await client.business.update({
      where: { id: business.id },
      data: { status: 'suspended' },
    });
    await assert.rejects(
      access.require(userId, business.id),
      /Business is not active/,
    );
    check('business suspension overrides a warmed Redis entry', true);
    await client.business.update({
      where: { id: business.id },
      data: { status: 'active' },
    });

    const beforeTruncate = await revision('user', userId);
    await pool.query('TRUNCATE "UserPreference"');
    check(
      'TRUNCATE maintenance invalidates preferences too',
      beforeTruncate !== (await revision('user', userId)),
    );
    check(
      'deleted preferences return defaults',
      !(await currentUser()).preferences.sidebarMinimized,
    );
    await client.userSession.update({
      where: { userSessionId: session.userSessionId },
      data: { revokedAt: new Date() },
    });
    await assert.rejects(currentUser(), /Authentication required/);
    check('logout rejects the next request despite a warm user cache', true);

    console.log(`${passed} real Redis/database cache checks passed.`);
  } finally {
    if (redis.isReady && keys.size) await redis.del([...keys]);
    if (redis.isOpen) await redis.close();
    await prisma?.$disconnect();
    await pool?.end();
    if (created) {
      assert.match(schema, /^read_cache_test_[a-f0-9]{16}$/);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.log(
        'Isolated schema and test Redis entries removed; public records unchanged.',
      );
    }
    await admin.end();
  }
}
void main().catch((error) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
