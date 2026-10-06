import { Module } from '@nestjs/common';
import { AuthCookieModule } from '../auth-cookie/auth-cookie.module';
import { EmailModule } from '../email/email.module';
import { LocationModule } from '../location/location.module';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetVerificationService } from './password-reset-verification.service';
import { PasswordResetService } from './password-reset.service';

@Module({
  imports: [EmailModule, LocationModule, AuthCookieModule],
  controllers: [PasswordResetController],
  providers: [PasswordResetService, PasswordResetVerificationService],
})
export class PasswordResetModule {}
