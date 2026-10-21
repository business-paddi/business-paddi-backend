import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { BusinessErrorFilter } from './business-error.filter';
import { BusinessCacheInterceptor } from './business-cache.interceptor';
import { UpdateGroupDto } from './business.dto';
import { GroupService } from './group.service';

@Controller('businesses/:businessId/groups')
@UseGuards(AccessTokenGuard)
@UseFilters(BusinessErrorFilter)
@UseInterceptors(BusinessCacheInterceptor)
export class GroupController {
  constructor(private readonly groups: GroupService) {}
  @Get(':groupId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('groupId') groupId: string,
  ) {
    return this.groups.get(request.auth.userId, businessId, groupId);
  }
  @Patch(':groupId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('groupId') groupId: string,
    @Body() body: UpdateGroupDto,
  ) {
    return this.groups.update(request.auth.userId, businessId, groupId, body);
  }
}
