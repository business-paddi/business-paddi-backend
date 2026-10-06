import {
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthCookieService } from '../auth-cookie/auth-cookie.service';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import { LocationService } from '../location/location.service';
import { SessionIdParamDto } from './dto/session-id-param.dto';
import { SessionService } from './session.service';

@Controller('sessions')
@UseGuards(AccessTokenGuard)
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly cookies: AuthCookieService,
    private readonly locations: LocationService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthenticatedRequest) {
    return this.sessions.listUserSessions(
      request.auth.userId,
      request.auth.userSessionId,
    );
  }

  @Delete('others')
  revokeOthers(@Req() request: AuthenticatedRequest) {
    return this.sessions.revokeOtherUserSessions(
      request.auth.userId,
      request.auth.userSessionId,
      this.locations.getRequestContext(request),
    );
  }

  @Delete(':sessionId')
  async revoke(
    @Param() params: SessionIdParamDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.sessions.revokeUserSession(
      request.auth.userId,
      request.auth.userSessionId,
      params.sessionId,
      this.locations.getRequestContext(request),
    );
    if (result.currentSessionRevoked) {
      this.cookies.clearAuthCookies(response);
    }
    return result;
  }
}
