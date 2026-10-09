import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { PrismaService } from '../database/prisma.service';
import { INVITE_SELECT } from './business.responses';

@Controller('notifications')
@UseGuards(AccessTokenGuard)
export class NotificationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthenticatedRequest) {
    const items = await this.prisma.userNotification.findMany({
      where: { userId: req.auth.userId },
      select: {
        id: true,
        type: true,
        readAt: true,
        createdAt: true,
        invite: {
          select: {
            ...INVITE_SELECT,
            business: { select: { id: true, name: true, profileImage: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: items.map((item) => ({
        ...item,
        invite: {
          ...item.invite,
          status:
            item.invite.status === 'pending' &&
            item.invite.expiresAt <= new Date()
              ? ('expired' as const)
              : item.invite.status,
        },
      })),
    };
  }

  @Patch(':notificationId/read')
  @Header('Cache-Control', 'no-store')
  async read(
    @Req() req: AuthenticatedRequest,
    @Param('notificationId') id: string,
  ) {
    const notification = await this.prisma.userNotification.findFirst({
      where: { id, userId: req.auth.userId },
      select: { id: true, readAt: true },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.readAt) return { notification };
    await this.prisma.userNotification.updateMany({
      where: { id, userId: req.auth.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return {
      notification: await this.prisma.userNotification.findFirst({
        where: { id, userId: req.auth.userId },
        select: { id: true, readAt: true },
      }),
    };
  }
}
