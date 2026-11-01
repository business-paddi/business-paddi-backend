import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../identity/auth-guard/authenticated-request';
import { AccessTokenGuard } from '../identity/auth-guard/access-token.guard';
import { AuditService } from './audit.service';
import { ListAuditEventsDto } from './dto/list-audit-events.dto';

@Controller('audit-events')
@UseGuards(AccessTokenGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListAuditEventsDto,
  ) {
    return this.audit.listUserEvents(request.auth.userId, query);
  }
}
