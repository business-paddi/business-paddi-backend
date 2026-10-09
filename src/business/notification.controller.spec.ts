import { NotificationController } from './notification.controller';
import type { PrismaService } from '../database/prisma.service';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';

describe('Personal invite notifications', () => {
  const db = {
    userNotification: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const controller = new NotificationController(db as unknown as PrismaService);
  const request = { auth: { userId: 'u' } } as AuthenticatedRequest;
  beforeEach(() => jest.resetAllMocks());

  it('lists only the signed-in user notifications and reports expiration', async () => {
    db.userNotification.findMany.mockResolvedValue([
      {
        id: 'n',
        invite: {
          id: 'i',
          status: 'pending',
          expiresAt: new Date(0),
        },
      },
    ]);
    const result = await controller.list(request);
    expect(db.userNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u' },
      }),
    );
    expect(result.items[0].invite.status).toBe('expired');
    const selection =
      db.userNotification.findMany.mock.calls[0][0].select.invite.select;
    expect(selection).not.toHaveProperty('tokenHash');
  });

  it('cannot mark another user notification read', async () => {
    db.userNotification.findFirst.mockResolvedValue(null);
    await expect(controller.read(request, 'foreign')).rejects.toMatchObject({
      status: 404,
    });
    expect(db.userNotification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'foreign', userId: 'u' },
      }),
    );
    expect(db.userNotification.updateMany).not.toHaveBeenCalled();
  });

  it('preserves the timestamp when already read', async () => {
    const notification = { id: 'n', readAt: new Date() };
    db.userNotification.findFirst.mockResolvedValue(notification);
    expect(await controller.read(request, 'n')).toEqual({ notification });
    expect(db.userNotification.updateMany).not.toHaveBeenCalled();
  });
});
