import {
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import { LocationService } from '../location/location.service';
import { UpsertOnboardingDto } from './dto/upsert-onboarding.dto';
import { OnboardingService } from './onboarding.service';

@Controller('account/onboarding')
@UseGuards(AccessTokenGuard)
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly locations: LocationService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  getDraft(@Req() request: AuthenticatedRequest) {
    return this.onboarding.getDraft(request.auth.userId);
  }

  @Patch()
  saveDraft(
    @Req() request: AuthenticatedRequest,
    @Body() input: UpsertOnboardingDto,
  ) {
    return this.onboarding.saveDraft(
      request.auth.userId,
      input,
      this.locations.getRequestContext(request),
    );
  }

  @Post('complete')
  complete(@Req() request: AuthenticatedRequest) {
    return this.onboarding.completeOnboarding(
      request.auth.userId,
      this.locations.getRequestContext(request),
    );
  }
}
