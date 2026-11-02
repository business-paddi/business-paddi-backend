import { UsersService } from './users.service';
import { ReadCacheService } from '../redis/read-cache.service';
import type { RedisService } from '../redis/redis.service';

describe('sanitized current-user cache', () => {
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
    const user = {
      id: 'u',
      name: 'David',
      passwordHash: 'secret-hash',
      preferences: null,
      authProviders: [{ provider: 'google', linkedAt: new Date() }],
    };
    const prisma = {
      user: {
        findUniqueOrThrow: jest
          .fn()
          .mockImplementation(() => Promise.resolve({ ...user })),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ revision: 'v2' }]),
    };
    const service = new UsersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      cache,
    );
    return { user, prisma, service, cache };
  }
  it('reuses sanitized data and preferences without loading the user again', async () => {
    const { service, prisma, cache } = fixture();
    const remember = jest.spyOn(cache, 'remember');
    const first = await service.getCurrentUser('u', 'v1');
    const hit = await service.getCurrentUser('u', 'v1');
    const preferences = await service.getPreferences('u', 'v1');
    expect(hit).toEqual(first);
    expect(preferences).toEqual(first.preferences);
    expect(hit).not.toHaveProperty('passwordHash');
    expect(hit.hasPassword).toBe(true);
    expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    // The loader passed to Redis returns only sanitized data.
    const load = remember.mock.calls[0][1];
    expect(await load()).not.toHaveProperty('passwordHash');
  });
  it('uses a new revision for updated profile data', async () => {
    const { service, user } = fixture();
    await service.getCurrentUser('u', 'v1');
    user.name = 'Amaka';
    expect((await service.getCurrentUser('u', 'v2')).name).toBe('Amaka');
  });
  it('looks up freshness when called outside the authenticated controller', async () => {
    const { service, prisma } = fixture();
    await service.getCurrentUser('u');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
