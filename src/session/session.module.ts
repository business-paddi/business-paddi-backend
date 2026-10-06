import { Module } from '@nestjs/common';
import { AuthTokenModule } from '../auth-token/auth-token.module';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { AuthCookieModule } from '../auth-cookie/auth-cookie.module';
import { LocationModule } from '../location/location.module';
import { AuthGuardModule } from '../auth-guard/auth-guard.module';

@Module({
  imports: [AuthTokenModule, AuthCookieModule, LocationModule, AuthGuardModule],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
