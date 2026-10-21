import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from './business-access.service';
import { UpdateGroupDto } from './business.dto';

@Injectable()
export class GroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
  ) {}

  async get(userId: string, businessId: string, groupId: string) {
    await this.access.require(userId, businessId, ['employee_lists:view']);
    const group = await this.prisma.employeeGroup.findUnique({
      where: { businessId_id: { businessId, id: groupId } },
    });
    if (!group) throw new NotFoundException('Group not found');
    return { group };
  }

  async update(
    userId: string,
    businessId: string,
    groupId: string,
    input: UpdateGroupDto,
  ) {
    return this.prisma.$transaction(
      async (db) => {
        await this.access.lock(
          userId,
          businessId,
          ['employee_lists:update'],
          db,
        );
        if (!Object.values(input).some((value) => value !== undefined))
          throw new BadRequestException('Provide at least one group field.');
        await db.$queryRaw`SELECT "id" FROM "EmployeeGroup" WHERE "businessId" = ${businessId} AND "id" = ${groupId} FOR UPDATE`;
        const group = await db.employeeGroup.findUnique({
          where: { businessId_id: { businessId, id: groupId } },
        });
        if (!group) throw new NotFoundException('Group not found');
        if (group.status !== 'active')
          throw new BadRequestException('Archived groups cannot be updated');
        // Existing configuration trigger + appearance trigger attribute the audit to access.lock's actor.
        return {
          group: await db.employeeGroup.update({
            where: { businessId_id: { businessId, id: groupId } },
            data: input,
          }),
        };
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
}
