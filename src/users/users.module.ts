import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { LocationModule } from '../location/location.module';
import { EmailModule } from '../email/email.module';
import { EmailChangeVerificationModule } from '../identity/email-change-verification/email-change-verification.module';
import { AuthGuardModule } from '../identity/auth-guard/auth-guard.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { SensitiveActionModule } from '../identity/sensitive-action/sensitive-action.module';

@Module({
  imports: [
    LocationModule,
    EmailModule,
    EmailChangeVerificationModule,
    AuthGuardModule,
    RateLimitModule,
    SensitiveActionModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
