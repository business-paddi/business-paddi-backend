import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import { LocationService } from '../location/location.service';
import { RequestSensitiveVerificationDto } from './dto/request-sensitive-verification.dto';
import { VerifySensitiveActionDto } from './dto/verify-sensitive-action.dto';
import { SensitiveActionVerificationService } from './sensitive-action-verification.service';

@Controller('account/security-verification')
@UseGuards(AccessTokenGuard)
export class SensitiveActionController {
  constructor(
    private readonly verification: SensitiveActionVerificationService,
    private readonly locations: LocationService,
  ) {}

  @Post('request')
  @HttpCode(HttpStatus.ACCEPTED)
  request(
    @Req() request: AuthenticatedRequest,
    @Body() input: RequestSensitiveVerificationDto,
  ) {
    return this.verification.issue(
      request.auth.userId,
      request.auth.userSessionId,
      input.action,
      this.locations.getRequestContext(request),
    );
  }

  @Post('verify')
  verify(
    @Req() request: AuthenticatedRequest,
    @Body() input: VerifySensitiveActionDto,
  ) {
    return this.verification.verify(
      request.auth.userId,
      request.auth.userSessionId,
      input.challengeId,
      input.code,
    );
  }
}
