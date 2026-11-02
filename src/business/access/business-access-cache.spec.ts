import { BusinessAccessService } from './business-access.service';
import { ReadCacheService } from '../../redis/read-cache.service';
import type { RedisService } from '../../redis/redis.service';
import type { PrismaService } from '../../database/prisma.service';

function fixture() {
  const entries = new Map<string, string>();
  const cache = new ReadCacheService({
    client: {
      isReady: true,
      get: (key: string) => Promise.resolve(entries.get(key) ?? null),
      set: (key: string, value: string) => {
        entries.set(key, value);
        return Promise.resolve('OK');
      },
    },
  } as unknown as RedisService);
  const member = {
    id: 'member',
    businessId: 'business',
    userId: 'user',
    status: 'active',
    role: {
      status: 'active',
      type: 'custom',
      businessId: 'business',
      permissions: [{ permission: 'reports:view' }],
      deniedPermissions: [],
    },
    business: { id: 'business', name: 'Old name', status: 'active' },
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ key: 'v1' }]),
    businessMember: {
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve(structuredClone(member))),
    },
  };
  return {
    member,
    prisma,
    service: new BusinessAccessService(
      prisma as unknown as PrismaService,
      cache,
    ),
  };
}

describe('workspace access cache', () => {
  it('checks primary versions every time but reuses the full access snapshot', async () => {
    const { service, prisma } = fixture();
    await service.require('user', 'business');
    await service.require('user', 'business');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.businessMember.findUnique).toHaveBeenCalledTimes(1);
  });
  it('checks requested permissions on a cache hit', async () => {
    const { service } = fixture();
    await service.require('user', 'business', ['reports:view']);
    await expect(
      service.require('user', 'business', ['members:remove']),
    ).rejects.toThrow('Missing business permission');
  });
  it('rejects a removed member even with a previously warmed cache', async () => {
    const { service, prisma } = fixture();
    await service.require('user', 'business');
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.require('user', 'business')).rejects.toThrow(
      'Business not found',
    );
  });
  it('honours suspension and permission denial after committed revisions change', async () => {
    const { service, prisma, member } = fixture();
    await service.require('user', 'business', ['reports:view']);
    prisma.$queryRaw.mockResolvedValue([{ key: 'v2' }]);
    member.role.deniedPermissions = [{ permission: 'reports:view' }] as never[];
    await expect(
      service.require('user', 'business', ['reports:view']),
    ).rejects.toThrow('Missing business permission');
    prisma.$queryRaw.mockResolvedValue([{ key: 'v3' }]);
    member.status = 'suspended';
    await expect(service.require('user', 'business')).rejects.toThrow(
      'Business access denied',
    );
  });
  it('refreshes business data after another member edits it', async () => {
    const { service, prisma, member } = fixture();
    await service.require('user', 'business');
    member.business.name = 'New name';
    prisma.$queryRaw.mockResolvedValue([{ key: 'v2' }]);
    expect(
      (await service.require('user', 'business')).member.business.name,
    ).toBe('New name');
  });
  it('bypasses Redis for transactional authorization', async () => {
    const { service, member, prisma } = fixture();
    await service.require('user', 'business');
    const transaction = {
      businessMember: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...member, status: 'suspended' }),
      },
    };
    await expect(
      service.require('user', 'business', [], transaction as never),
    ).rejects.toThrow('Business access denied');
    expect(transaction.businessMember.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
