import {
  Controller,
  BadRequestException,
  Query,
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
import { NotificationQuery } from './notification-query.dto';
import { INVITE_SELECT } from './business.responses';

@Controller('notifications')
@UseGuards(AccessTokenGuard)
export class NotificationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() query: NotificationQuery = new NotificationQuery(),
  ) {
    const anchor = query.cursor
      ? await this.prisma.userNotification.findFirst({
          where: { id: query.cursor, userId: req.auth.userId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (query.cursor && !anchor)
      throw new BadRequestException('Invalid notification cursor');
    const items = await this.prisma.userNotification.findMany({
      where: {
        userId: req.auth.userId,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(anchor
          ? {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        actionUrl: true,
        data: true,
        businessId: true,
        readAt: true,
        createdAt: true,
        invite: {
          select: {
            ...INVITE_SELECT,
            business: { select: { id: true, name: true, profileImage: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return {
      nextCursor:
        items.length > query.limit
          ? (items[query.limit - 1]?.id ?? null)
          : null,
      unreadCount: await this.prisma.userNotification.count({
        where: { userId: req.auth.userId, readAt: null },
      }),
      items: items.slice(0, query.limit).map((item) => ({
        ...item,
        title:
          item.title ??
          (item.invite ? `Invitation to ${item.invite.business.name}` : null),
        actionUrl:
          item.actionUrl ??
          (item.invite
            ? `/dashboard/invites?inviteId=${item.invite.id}`
            : null),
        businessId: item.businessId ?? item.invite?.businessId ?? null,
        invite: item.invite
          ? {
              ...item.invite,
              status:
                item.invite.status === 'pending' &&
                item.invite.expiresAt <= new Date()
                  ? ('expired' as const)
                  : item.invite.status,
            }
          : null,
      })),
    };
  }

  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  async unread(@Req() req: AuthenticatedRequest) {
    return {
      unreadCount: await this.prisma.userNotification.count({
        where: { userId: req.auth.userId, readAt: null },
      }),
    };
  }
  @Patch('read-all')
  @Header('Cache-Control', 'no-store')
  async readAll(@Req() req: AuthenticatedRequest) {
    const result = await this.prisma.userNotification.updateMany({
      where: { userId: req.auth.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updatedCount: result.count };
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
