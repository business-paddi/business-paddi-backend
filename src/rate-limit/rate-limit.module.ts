import { Module } from '@nestjs/common';
import { LoginRateLimitService } from './login-rate-limit.service';
import { SensitiveActionRateLimitService } from './sensitive-action-rate-limit.service';
import { AuthenticatedRateLimitService } from './authenticated-rate-limit.service';

@Module({
  providers: [
    AuthenticatedRateLimitService,
    LoginRateLimitService,
    SensitiveActionRateLimitService,
  ],
  exports: [
    AuthenticatedRateLimitService,
    LoginRateLimitService,
    SensitiveActionRateLimitService,
  ],
})
export class RateLimitModule {}
