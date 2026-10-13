import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { BusinessErrorFilter } from './business-error.filter';
import { MemberApprovalService } from './member-approval.service';

export class RejectMemberDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

@Controller('businesses/:businessId')
@UseGuards(AccessTokenGuard)
@UseFilters(BusinessErrorFilter)
export class MemberApprovalController {
  constructor(private readonly approvals: MemberApprovalService) {}
  @Get('member-approvals')
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') businessId: string,
  ) {
    return this.approvals.list(req.auth.userId, businessId);
  }
  @Post('members/:memberId/approve')
  @Header('Cache-Control', 'no-store')
  approve(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.approvals.review(req.auth.userId, businessId, memberId, true);
  }
  @Post('members/:memberId/reject')
  @Header('Cache-Control', 'no-store')
  reject(
    @Req() req: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Param('memberId') memberId: string,
    @Body() body: RejectMemberDto,
  ) {
    return this.approvals.review(
      req.auth.userId,
      businessId,
      memberId,
      false,
      body.reason,
    );
  }
}
