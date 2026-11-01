import { Module } from '@nestjs/common';
import { AuthCookieService } from './auth-cookie.service';

@Module({
  providers: [AuthCookieService],
  exports: [AuthCookieService],
})
export class AuthCookieModule {}
