import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { BusinessErrorFilter } from './business-error.filter';
import {
  BusinessAuditService,
  BusinessAuditQuery,
} from './business-audit.service';

@Controller('businesses/:businessId/audit-events')
@UseGuards(AccessTokenGuard)
@UseFilters(BusinessErrorFilter)
export class BusinessAuditController {
  constructor(private readonly audit: BusinessAuditService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() request: AuthenticatedRequest,
    @Param('businessId') businessId: string,
    @Query() query: BusinessAuditQuery,
  ) {
    return this.audit.list(request.auth.userId, businessId, query);
  }
}
