import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { EmailModule } from '../email/email.module';
import { VerificationCodeModule } from '../verification-code/verification-code.module';
import { SessionModule } from '../session/session.module';
import { AuthCookieModule } from '../auth-cookie/auth-cookie.module';
import { LocationModule } from '../location/location.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { LoginVerificationModule } from '../login-verification/login-verification.module';
import { GoogleAuthModule } from '../google-auth/google-auth.module';
import { AuthGuardModule } from '../auth-guard/auth-guard.module';
import { AuthTokenModule } from '../auth-token/auth-token.module';

@Module({
  controllers: [AuthController],
  providers: [AuthService],
  imports: [
    EmailModule,
    VerificationCodeModule,
    SessionModule,
    AuthCookieModule,
    LocationModule,
    RateLimitModule,
    LoginVerificationModule,
    GoogleAuthModule,
    AuthGuardModule,
    AuthTokenModule,
  ],
})
export class AuthModule {}
