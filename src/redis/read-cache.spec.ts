import { serialize } from 'node:v8';
import { types } from 'node:util';
import { ReadCacheService } from './read-cache.service';
import type { RedisService } from './redis.service';

function fixture() {
  const entries = new Map<string, string>();
  const client = {
    isReady: true,
    get: jest.fn((key: string) => Promise.resolve(entries.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      entries.set(key, value);
      return Promise.resolve('OK');
    }),
  };
  const service = new ReadCacheService({ client } as unknown as RedisService);
  return { service, client, entries };
}

describe('versioned Redis read cache', () => {
  it('loads once, preserves Date values, and expires entries in five minutes', async () => {
    const { service, client } = fixture();
    const value = { createdAt: new Date(), name: 'David' };
    const load = jest.fn(() => Promise.resolve(value));
    await service.remember('user:1:v1', load);
    const cached = await service.remember('user:1:v1', load);
    expect(cached).toEqual(value);
    expect(types.isDate(cached.createdAt)).toBe(true);
    expect(cached.createdAt.getTime()).toBe(value.createdAt.getTime());
    expect(load).toHaveBeenCalledTimes(1);
    expect(client.set).toHaveBeenCalledWith('user:1:v1', expect.any(String), {
      EX: 300,
    });
  });

  it('does not reuse an older revision or another tenant', async () => {
    const { service } = fixture();
    await service.remember('access:a:u:v1', () =>
      Promise.resolve(['reports:view']),
    );
    expect(
      await service.remember('access:a:u:v2', () => Promise.resolve([])),
    ).toEqual([]);
    expect(
      await service.remember('access:b:u:v1', () => Promise.resolve([])),
    ).toEqual([]);
  });

  it('coalesces simultaneous misses in this process', async () => {
    const { service } = fixture();
    let finish!: (value: string) => void;
    const load = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const first = service.remember('u:v1', load);
    const second = service.remember('u:v1', load);
    await new Promise((resolve) => setImmediate(resolve));
    finish('loaded');
    expect(await Promise.all([first, second])).toEqual(['loaded', 'loaded']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a slow fill for an old revision cannot poison the new revision', async () => {
    const { service } = fixture();
    let finish!: (value: string) => void;
    const stale = service.remember(
      'u:v1',
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await service.remember('u:v2', () => Promise.resolve('new'));
    finish('old');
    await stale;
    expect(await service.remember('u:v2', () => Promise.resolve('wrong'))).toBe(
      'new',
    );
  });

  it('does not cache database errors or denied access', async () => {
    const { service, client } = fixture();
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('Forbidden'))
      .mockResolvedValue('allowed');
    await expect(service.remember('u:v1', load)).rejects.toThrow('Forbidden');
    expect(client.set).not.toHaveBeenCalled();
    expect(await service.remember('u:v1', load)).toBe('allowed');
  });

  it('falls back when Redis is disconnected, corrupt, or rejects commands', async () => {
    const { service, client, entries } = fixture();
    client.isReady = false;
    expect(await service.remember('u:1', () => Promise.resolve('db'))).toBe(
      'db',
    );
    expect(client.get).not.toHaveBeenCalled();
    client.isReady = true;
    entries.set('u:2', 'corrupt');
    expect(await service.remember('u:2', () => Promise.resolve('db'))).toBe(
      'db',
    );
    client.get.mockRejectedValueOnce(new Error('Redis down'));
    client.set.mockRejectedValueOnce(new Error('Redis down'));
    expect(await service.remember('u:3', () => Promise.resolve('db'))).toBe(
      'db',
    );
  });

  it('bounds slow Redis reads and writes', async () => {
    const { service, client } = fixture();
    client.get.mockImplementationOnce(() => new Promise(() => {}));
    client.set.mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    expect(await service.remember('u:v1', () => Promise.resolve('db'))).toBe(
      'db',
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads entries written by another instance', async () => {
    const { service, entries } = fixture();
    entries.set('u:v1', serialize({ name: 'Amaka' }).toString('base64'));
    const load = jest.fn();
    expect(await service.remember('u:v1', load)).toEqual({ name: 'Amaka' });
    expect(load).not.toHaveBeenCalled();
  });
});
