import type { ExecutionContext } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard';
import type { AuthTokenService } from '../auth-token/auth-token.service';
import type { PrismaService } from '../../database/prisma.service';

describe('live session checks with cached user payloads', () => {
  const claims = { userId: 'u', userSessionId: 's', tokenId: 't' };
  function fixture() {
    const request = { cookies: { accessToken: 'signed-token' } };
    const row = {
      userId: 'u',
      currentAuthSessionId: 'a',
      revokedAt: null,
      emailVerifiedAt: new Date(),
      status: 'active',
      revision: 'v1',
    };
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([row]) };
    const auth = { verifyAccessToken: jest.fn().mockResolvedValue(claims) };
    const guard = new AccessTokenGuard(
      auth as unknown as AuthTokenService,
      prisma as unknown as PrismaService,
    );
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { request, row, prisma, auth, guard, context };
  }
  it('attaches the trusted user revision and checks the session on every request', async () => {
    const { guard, context, prisma, request } = fixture();
    await guard.canActivate(context);
    await guard.canActivate(context);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(request).toHaveProperty('auth.userCacheRevision', 'v1');
  });
  it.each([
    { revokedAt: new Date() },
    { currentAuthSessionId: null },
    { emailVerifiedAt: null },
    { status: 'suspended' },
    { userId: 'someone-else' },
  ])('rejects invalidated session state %p', async (change) => {
    const { guard, context, row } = fixture();
    Object.assign(row, change);
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Authentication required',
    );
  });
  it('rejects absent sessions and invalid tokens', async () => {
    const { guard, context, prisma, auth } = fixture();
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Authentication required',
    );
    auth.verifyAccessToken.mockRejectedValue(new Error('Expired'));
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Authentication required',
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
