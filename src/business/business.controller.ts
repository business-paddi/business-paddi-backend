import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { BusinessService } from './business.service';
import { EmployeeService } from './employee.service';
import { InviteService } from './invite.service';
import {
  AcceptInviteDto,
  BusinessDto,
  EmployeeDto,
  EmployeeQueryDto,
  EmployeeTypeDto,
  GroupDto,
  InviteDto,
  OnboardDto,
  TaxProfileDto,
  UpdateBusinessDto,
  UpdateEmployeeDto,
} from './business.dto';
import { BusinessErrorFilter } from './business-error.filter';
import { BusinessCacheInterceptor } from './business-cache.interceptor';

@Controller('businesses')
@UseGuards(AccessTokenGuard)
@UseFilters(BusinessErrorFilter)
@UseInterceptors(BusinessCacheInterceptor)
export class BusinessController {
  constructor(
    private readonly businesses: BusinessService,
    private readonly employees: EmployeeService,
    private readonly invites: InviteService,
  ) {}
  @Post() create(
    @Req() req: AuthenticatedRequest,
    @Body() body: BusinessDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.businesses.create(req.auth.userId, body, key);
  }
  @Post('onboard') onboard(
    @Req() req: AuthenticatedRequest,
    @Body() body: OnboardDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.businesses.onboard(req.auth.userId, body, key);
  }
  @Get() list(@Req() req: AuthenticatedRequest) {
    return this.businesses.list(req.auth.userId);
  }
  @Get(':businessId') get(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
  ) {
    return this.businesses.get(req.auth.userId, id);
  }
  @Patch(':businessId') update(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Body() body: UpdateBusinessDto,
  ) {
    return this.businesses.update(req.auth.userId, id, body);
  }
  @Get(':businessId/summary') summary(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
  ) {
    return this.businesses.summary(req.auth.userId, id);
  }
  @Post(':businessId/employees') createEmployee(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Body() body: EmployeeDto,
  ) {
    return this.employees.create(req.auth.userId, id, body);
  }
  @Get(':businessId/employees') listEmployees(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Query() query: EmployeeQueryDto,
  ) {
    return this.employees.list(req.auth.userId, id, query);
  }
  @Get(':businessId/employees/:employeeId') getEmployee(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.employees.get(req.auth.userId, id, employeeId);
  }
  @Patch(':businessId/employees/:employeeId') updateEmployee(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Param('employeeId') employeeId: string,
    @Body() body: UpdateEmployeeDto,
  ) {
    return this.employees.update(req.auth.userId, id, employeeId, body);
  }
  @Patch(':businessId/employees/:employeeId/archive') archiveEmployee(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.employees.archive(req.auth.userId, id, employeeId);
  }
  @Get(':businessId/employee-types') types(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
  ) {
    return this.businesses.types(req.auth.userId, id);
  }
  @Post(':businessId/employee-types') createType(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Body() body: EmployeeTypeDto,
  ) {
    return this.businesses.createType(req.auth.userId, id, body);
  }
  @Get(':businessId/groups') groups(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
  ) {
    return this.businesses.groups(req.auth.userId, id);
  }
  @Post(':businessId/groups') createGroup(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Body() body: GroupDto,
  ) {
    return this.businesses.createGroup(req.auth.userId, id, body);
  }
  @Get(':businessId/members') members(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
  ) {
    return this.businesses.members(req.auth.userId, id);
  }
  @Get(':businessId/members/:memberId') member(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.businesses.member(req.auth.userId, businessId, memberId);
  }
  @Get(':businessId/roles') roles(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
  ) {
    return this.businesses.roles(req.auth.userId, id);
  }
  @Get(':businessId/roles/:roleId') role(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Param('roleId') roleId: string,
  ) {
    return this.businesses.roles(req.auth.userId, id, roleId);
  }
  @Get(':businessId/invites') invitations(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
  ) {
    return this.invites.list(req.auth.userId, id);
  }
  @Post(':businessId/invites') createInvite(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Body() body: InviteDto,
  ) {
    return this.invites.create(req.auth.userId, id, body);
  }
  @Post(':businessId/invites/:inviteId/revoke') revoke(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invites.revoke(req.auth.userId, id, inviteId);
  }
  @Post(':businessId/invites/:inviteId/resend') resend(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invites.resend(req.auth.userId, id, inviteId);
  }
  @Get(':businessId/employees/:employeeId/tax-profile') tax(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.employees.tax(req.auth.userId, id, employeeId);
  }
  @Put(':businessId/employees/:employeeId/tax-profile') putTax(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') id: string,
    @Param('employeeId') employeeId: string,
    @Body() body: TaxProfileDto,
  ) {
    return this.employees.putTax(req.auth.userId, id, employeeId, body);
  }
}

@Controller('business-invites')
@UseGuards(AccessTokenGuard)
@UseFilters(BusinessErrorFilter)
export class BusinessInviteController {
  constructor(private readonly invites: InviteService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthenticatedRequest) {
    return this.invites.personalList(req.auth.userId);
  }
  @Post(':inviteId/accept')
  @Header('Cache-Control', 'no-store')
  acceptById(
    @Req() req: AuthenticatedRequest,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invites.acceptById(req.auth.userId, inviteId);
  }
  @Post('accept')
  @Header('Cache-Control', 'no-store')
  accept(@Req() req: AuthenticatedRequest, @Body() body: AcceptInviteDto) {
    return this.invites.accept(req.auth.userId, body);
  }
}
