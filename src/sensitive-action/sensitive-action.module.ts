import { Module } from '@nestjs/common';
import { AuthGuardModule } from '../auth-guard/auth-guard.module';
import { EmailModule } from '../email/email.module';
import { LocationModule } from '../location/location.module';
import { SensitiveActionController } from './sensitive-action.controller';
import { SensitiveActionVerificationService } from './sensitive-action-verification.service';

@Module({
  imports: [AuthGuardModule, EmailModule, LocationModule],
  controllers: [SensitiveActionController],
  providers: [SensitiveActionVerificationService],
  exports: [SensitiveActionVerificationService],
})
export class SensitiveActionModule {}
