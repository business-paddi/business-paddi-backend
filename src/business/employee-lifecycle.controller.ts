import {
  Body,
  Controller,
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
import { EmployeeLifecycleService } from './employee-lifecycle.service';
import {
  EmployeeLifecycleNoteDto,
  ScheduleEmployeeDeletionDto,
} from './employee-lifecycle.dto';

@Controller('businesses/:businessId/employees/:employeeId')
@UseGuards(AccessTokenGuard)
@UseFilters(BusinessErrorFilter)
@UseInterceptors(BusinessCacheInterceptor)
export class EmployeeLifecycleController {
  constructor(private readonly lifecycle: EmployeeLifecycleService) {}
  @Patch('schedule-deletion')
  schedule(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('employeeId') employeeId: string,
    @Body() body: ScheduleEmployeeDeletionDto,
  ) {
    return this.lifecycle.mutate(
      r.auth.userId,
      businessId,
      employeeId,
      'schedule',
      body.scheduledFor,
      body.reason,
    );
  }
  @Patch('cancel-deletion')
  cancel(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('employeeId') employeeId: string,
    @Body() body: EmployeeLifecycleNoteDto,
  ) {
    return this.lifecycle.mutate(
      r.auth.userId,
      businessId,
      employeeId,
      'cancel',
      undefined,
      body?.reason,
    );
  }
  @Patch('delete')
  remove(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('employeeId') employeeId: string,
    @Body() body: EmployeeLifecycleNoteDto,
  ) {
    return this.lifecycle.mutate(
      r.auth.userId,
      businessId,
      employeeId,
      'delete',
      undefined,
      body?.reason,
    );
  }
  @Patch('restore')
  restore(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('employeeId') employeeId: string,
    @Body() body: EmployeeLifecycleNoteDto,
  ) {
    return this.lifecycle.mutate(
      r.auth.userId,
      businessId,
      employeeId,
      'restore',
      undefined,
      body?.reason,
    );
  }
}
