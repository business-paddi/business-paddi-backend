import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { PolicyErrorFilter } from './policy-error.filter';
import {
  AssignPolicyDto,
  CreatePolicyClassesDto,
  PolicyDraftDto,
} from './policy.dto';
import { PolicyService } from './policy.service';
import { PolicyChatService } from './policy-chat.service';
import { PolicyChatReplyDto } from './policy-chat.dto';

@Controller('businesses/:businessId/policies')
@UseGuards(AccessTokenGuard)
@UseFilters(PolicyErrorFilter)
export class PolicyController {
  constructor(
    private readonly policies: PolicyService,
    private readonly chat: PolicyChatService,
  ) {}
  @Get('chat')
  @Header('Cache-Control', 'no-store')
  startChat(@Req() r: AuthenticatedRequest, @Param('businessId') b: string) {
    return this.chat.start(r.auth.userId, b);
  }
  @Post('chat/replies')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  replyToChat(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() body: PolicyChatReplyDto,
  ) {
    return this.chat.respond(r.auth.userId, b, body);
  }
  @Get('setup')
  @Header('Cache-Control', 'no-store')
  setup(@Req() r: AuthenticatedRequest, @Param('businessId') b: string) {
    return this.policies.setup(r.auth.userId, b);
  }
  @Post('classes')
  classes(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() body: CreatePolicyClassesDto,
  ) {
    return this.policies.createClasses(r.auth.userId, b, body);
  }
  @Post('preview')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  preview(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() body: PolicyDraftDto,
  ) {
    return this.policies.preview(r.auth.userId, b, body);
  }
  @Post()
  create(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() body: PolicyDraftDto,
  ) {
    return this.policies.create(r.auth.userId, b, body);
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.policies.list(r.auth.userId, b, cursor);
  }
  @Get('employees/:employeeId/assignments')
  @Header('Cache-Control', 'no-store')
  assignments(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('employeeId') e: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.policies.assignments(r.auth.userId, b, e, cursor);
  }
  @Post(':policyId/assignments')
  assign(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('policyId') p: string,
    @Body() body: AssignPolicyDto,
  ) {
    return this.policies.assign(r.auth.userId, b, p, body.employeeId);
  }
}
