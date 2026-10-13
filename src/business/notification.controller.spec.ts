import { NotificationController } from './notification.controller';
import type { PrismaService } from '../database/prisma.service';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';

describe('Personal invite notifications', () => {
  const db = {
    userNotification: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const controller = new NotificationController(db as unknown as PrismaService);
  const request = { auth: { userId: 'u' } } as AuthenticatedRequest;
  beforeEach(() => {
    jest.resetAllMocks();
    db.userNotification.count.mockResolvedValue(0);
  });

  it('lists only the signed-in user notifications and reports expiration', async () => {
    db.userNotification.findMany.mockResolvedValue([
      {
        id: 'n',
        invite: {
          id: 'i',
          businessId: 'b',
          business: { name: 'Test business' },
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
    expect(result.items[0].invite?.status).toBe('expired');
    const selection = (
      (db.userNotification.findMany.mock.calls as unknown[][])[0][0] as {
        select: { invite: { select: Record<string, boolean> } };
      }
    ).select.invite.select;
    expect(selection).not.toHaveProperty('tokenHash');
  });
  it('supports generic notifications without an invitation', async () => {
    db.userNotification.findMany.mockResolvedValue([
      {
        id: 'security',
        type: 'account_security',
        title: 'Password changed',
        invite: null,
      },
    ]);
    const result = await controller.list(request);
    expect(result.items[0].invite).toBeNull();
    expect(result.items[0].title).toBe('Password changed');
  });
  it('rejects foreign cursors and scopes unread/count/read-all to the current user', async () => {
    db.userNotification.findFirst.mockResolvedValue(null);
    await expect(
      controller.list(request, { cursor: 'foreign', limit: 30 }),
    ).rejects.toMatchObject({ status: 400 });
    db.userNotification.updateMany.mockResolvedValue({ count: 2 });
    expect(await controller.readAll(request)).toEqual({ updatedCount: 2 });
    expect(db.userNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u', readAt: null } }),
    );
    await controller.unread(request);
    expect(db.userNotification.count).toHaveBeenCalledWith({
      where: { userId: 'u', readAt: null },
    });
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
